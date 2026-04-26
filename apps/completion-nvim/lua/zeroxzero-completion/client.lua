--- WebSocket client for the local 0x0 server.

local M = {}

local uv = vim.uv or vim.loop
local bit = bit or bit32

local socket = nil
local connected = false
local connecting = false
local read_buffer = ""
local write_queue = {}
local pending = {}
local request_seq = 0

local function websocket_url(server_url)
  local scheme, rest = server_url:match("^(https?)://(.+)$")
  if not scheme then
    return server_url
  end
  local ws_scheme = scheme == "https" and "wss" or "ws"
  return ws_scheme .. "://" .. rest:gsub("/$", "") .. "/ws"
end

local function parse_url(url)
  local scheme, host, port, path = url:match("^(wss?)://([^:/]+):?(%d*)(/.*)$")
  if not scheme then
    error("Invalid WebSocket URL: " .. url)
  end
  if scheme == "wss" then
    error("wss is not supported by the local TCP client")
  end
  return host, tonumber(port) or 80, path
end

local function b64(data)
  local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  return (
    (data:gsub(".", function(char)
      local byte = char:byte()
      local bits = ""
      for i = 7, 0, -1 do
        bits = bits .. (bit.band(byte, bit.lshift(1, i)) ~= 0 and "1" or "0")
      end
      return bits
    end) .. "0000"):gsub("%d%d%d?%d?%d?%d?", function(bits)
      if #bits < 6 then
        return ""
      end
      local value = 0
      for i = 1, 6 do
        if bits:sub(i, i) == "1" then
          value = value + 2 ^ (6 - i)
        end
      end
      return alphabet:sub(value + 1, value + 1)
    end) .. ({ "", "==", "=" })[#data % 3 + 1]
  )
end

local function random_bytes(len)
  local bytes = {}
  for i = 1, len do
    bytes[i] = string.char(math.random(0, 255))
  end
  return table.concat(bytes)
end

local function close_socket()
  connected = false
  connecting = false
  read_buffer = ""
  write_queue = {}

  if socket and not socket:is_closing() then
    socket:read_stop()
    socket:close()
  end
  socket = nil
end

local function finish_request(id, err)
  local callbacks = pending[id]
  if not callbacks then
    return
  end
  pending[id] = nil
  vim.schedule(function()
    callbacks.on_done(err)
  end)
end

local function fail_pending(err)
  local ids = vim.tbl_keys(pending)
  for _, id in ipairs(ids) do
    finish_request(id, err)
  end
end

local function encode_frame(payload)
  local payload_len = #payload
  local parts = { string.char(0x81) }

  if payload_len < 126 then
    table.insert(parts, string.char(0x80 + payload_len))
  elseif payload_len <= 0xffff then
    table.insert(parts, string.char(0x80 + 126, math.floor(payload_len / 256), payload_len % 256))
  else
    local bytes = {}
    local remaining = payload_len
    for i = 8, 1, -1 do
      bytes[i] = remaining % 256
      remaining = math.floor(remaining / 256)
    end
    table.insert(parts, string.char(0x80 + 127, unpack(bytes)))
  end

  local mask = random_bytes(4)
  table.insert(parts, mask)

  local masked = {}
  for i = 1, payload_len do
    local key = mask:byte(((i - 1) % 4) + 1)
    masked[i] = string.char(bit.bxor(payload:byte(i), key))
  end
  table.insert(parts, table.concat(masked))

  return table.concat(parts)
end

local function send_json(message)
  local payload = vim.json.encode(message)
  if not connected or not socket then
    table.insert(write_queue, payload)
    return
  end
  socket:write(encode_frame(payload))
end

local function flush_queue()
  local queued = write_queue
  write_queue = {}
  for _, payload in ipairs(queued) do
    socket:write(encode_frame(payload))
  end
end

local function decode_frames()
  while true do
    if #read_buffer < 2 then
      return
    end

    local b1 = read_buffer:byte(1)
    local b2 = read_buffer:byte(2)
    local opcode = bit.band(b1, 0x0f)
    local masked = bit.band(b2, 0x80) ~= 0
    local len = bit.band(b2, 0x7f)
    local offset = 3

    if len == 126 then
      if #read_buffer < 4 then
        return
      end
      len = read_buffer:byte(3) * 256 + read_buffer:byte(4)
      offset = 5
    elseif len == 127 then
      if #read_buffer < 10 then
        return
      end
      len = 0
      for i = 3, 10 do
        len = len * 256 + read_buffer:byte(i)
      end
      offset = 11
    end

    local mask
    if masked then
      if #read_buffer < offset + 3 then
        return
      end
      mask = read_buffer:sub(offset, offset + 3)
      offset = offset + 4
    end

    if #read_buffer < offset + len - 1 then
      return
    end

    local payload = read_buffer:sub(offset, offset + len - 1)
    read_buffer = read_buffer:sub(offset + len)

    if masked and mask then
      local unmasked = {}
      for i = 1, #payload do
        local key = mask:byte(((i - 1) % 4) + 1)
        unmasked[i] = string.char(bit.bxor(payload:byte(i), key))
      end
      payload = table.concat(unmasked)
    end

    if opcode == 0x1 then
      local ok, message = pcall(vim.json.decode, payload)
      if ok and type(message) == "table" then
        M._handle_message(message)
      end
    elseif opcode == 0x8 then
      close_socket()
      fail_pending("WebSocket closed")
      return
    end
  end
end

local function connect(server_url)
  if connected or connecting then
    return
  end

  connecting = true
  local host, port, path = parse_url(websocket_url(server_url))
  local tcp = uv.new_tcp()
  socket = tcp

  tcp:connect(host, port, function(err)
    if err then
      close_socket()
      fail_pending(err)
      return
    end

    local key = b64(random_bytes(16))
    tcp:write(table.concat({
      "GET " .. path .. " HTTP/1.1",
      "Host: " .. host .. ":" .. port,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: " .. key,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    }, "\r\n"))

    tcp:read_start(function(read_err, chunk)
      if read_err then
        close_socket()
        fail_pending(read_err)
        return
      end
      if not chunk then
        close_socket()
        fail_pending("WebSocket closed")
        return
      end

      read_buffer = read_buffer .. chunk

      if not connected then
        local header_end = read_buffer:find("\r\n\r\n", 1, true)
        if not header_end then
          return
        end

        local header = read_buffer:sub(1, header_end + 3)
        read_buffer = read_buffer:sub(header_end + 4)
        if not header:match("^HTTP/1%.1 101") then
          close_socket()
          fail_pending("WebSocket upgrade failed")
          return
        end

        connected = true
        connecting = false
        flush_queue()
      end

      decode_frames()
    end)
  end)
end

function M._handle_message(message)
  if message.type == "chat_event" and message.id then
    local callbacks = pending[message.id]
    if not callbacks or type(message.event) ~= "table" then
      return
    end

    if message.event.type == "text_delta" and message.event.text then
      vim.schedule(function()
        callbacks.on_chunk(message.event.text)
      end)
    elseif message.event.type == "done" then
      finish_request(message.id, nil)
    elseif message.event.type == "error" then
      finish_request(message.id, message.event.error or "unknown error")
    end
  elseif message.type == "error" then
    finish_request(message.id, message.error or "unknown error")
  elseif message.type == "cancelled" and message.id then
    finish_request(message.id, "cancelled")
  end
end

--- Send a streaming completion request over the persistent local WebSocket.
---@param server_url string
---@param request zeroxzero_completion.Request
---@param on_chunk fun(text: string)
---@param on_done fun(err?: string)
---@return fun() abort function
function M.stream_completion(server_url, request, on_chunk, on_done)
  request_seq = request_seq + 1
  local id = "completion-" .. request_seq

  pending[id] = {
    on_chunk = on_chunk,
    on_done = on_done,
  }

  send_json({
    type = "completion",
    id = id,
    request = {
      prefix = request.prefix,
      suffix = request.suffix,
      language = request.language,
      filepath = request.filepath,
      maxTokens = request.max_tokens,
      temperature = request.temperature,
      provider = request.provider,
      model = request.model,
      stream = true,
    },
  })

  connect(server_url)

  return function()
    if pending[id] then
      send_json({ type = "cancel", id = id })
      pending[id] = nil
    end
  end
end

function M.close()
  close_socket()
  fail_pending("WebSocket closed")
end

return M
