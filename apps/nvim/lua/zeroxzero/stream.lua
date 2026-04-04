--- SSE (Server-Sent Events) frame parser for 0x0 server responses.
--- Parses "data: {json}\n\n" format, handling partial chunks across reads.

local M = {}

--- Create a new SSE stream parser.
---@param on_event fun(event: table) Called for each parsed SSE event
---@return fun(chunk: string) Feed chunks of data into the parser
function M.create_parser(on_event)
  local buffer = ""

  return function(chunk)
    buffer = buffer .. chunk
    -- Normalize line endings
    buffer = buffer:gsub("\r\n", "\n"):gsub("\r", "\n")

    while true do
      -- Find the next complete SSE frame (terminated by double newline)
      local frame_end = buffer:find("\n\n")
      if not frame_end then
        break
      end

      local frame = buffer:sub(1, frame_end - 1)
      buffer = buffer:sub(frame_end + 2)

      -- Extract data lines from the frame
      local data_parts = {}
      for line in frame:gmatch("[^\n]+") do
        if line:sub(1, 6) == "data: " then
          table.insert(data_parts, line:sub(7))
        elseif line:sub(1, 5) == "data:" then
          table.insert(data_parts, line:sub(6))
        end
      end

      if #data_parts > 0 then
        local data = table.concat(data_parts, "\n")
        if data == "[DONE]" then
          on_event({ type = "done" })
        else
          local ok, event = pcall(vim.json.decode, data)
          if ok and type(event) == "table" then
            on_event(event)
          end
        end
      end
    end
  end
end

return M
