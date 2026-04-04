--- HTTP client for the 0x0 completion server endpoint.
--- Handles streaming SSE requests to POST /completions.

local M = {}

---@class zeroxzero_completion.Request
---@field prefix string
---@field suffix string
---@field language string
---@field filepath string
---@field max_tokens? integer
---@field temperature? number
---@field provider? string
---@field model? string

--- Send a streaming completion request.
---@param server_url string
---@param request zeroxzero_completion.Request
---@param on_chunk fun(text: string) Called for each text chunk
---@param on_done fun(err?: string) Called on completion or error
---@return fun() abort function
function M.stream_completion(server_url, request, on_chunk, on_done)
  local body = {
    prefix = request.prefix,
    suffix = request.suffix,
    language = request.language,
    filepath = request.filepath,
    max_tokens = request.max_tokens,
    temperature = request.temperature,
    provider = request.provider,
    model = request.model,
    stream = true,
  }

  local json_body = vim.json.encode(body)
  local buffer = ""
  local done_called = false

  local function finish(err)
    if done_called then
      return
    end
    done_called = true
    vim.schedule(function()
      on_done(err)
    end)
  end

  local job_id = vim.fn.jobstart({
    "curl",
    "-s",
    "-N",
    "-H",
    "Content-Type: application/json",
    "-H",
    "Accept: text/event-stream",
    "-X",
    "POST",
    "-d",
    json_body,
    server_url .. "/completions",
  }, {
    on_stdout = function(_, data)
      if not data then
        return
      end
      for _, line in ipairs(data) do
        if line ~= "" then
          buffer = buffer .. line .. "\n"
        else
          -- Empty line = SSE frame boundary
          buffer = buffer .. "\n"
        end

        -- Process complete SSE frames
        while true do
          local frame_end = buffer:find("\n\n")
          if not frame_end then
            break
          end

          local frame = buffer:sub(1, frame_end - 1)
          buffer = buffer:sub(frame_end + 2)

          for fline in frame:gmatch("[^\n]+") do
            if fline:sub(1, 6) == "data: " then
              local json_str = fline:sub(7)
              local ok, event = pcall(vim.json.decode, json_str)
              if ok and type(event) == "table" then
                if event.type == "text_delta" and event.text then
                  vim.schedule(function()
                    on_chunk(event.text)
                  end)
                elseif event.type == "done" then
                  finish(nil)
                elseif event.type == "error" then
                  finish(event.error or "unknown error")
                end
              end
            end
          end
        end
      end
    end,
    on_stderr = function() end,
    on_exit = function(_, code)
      if code ~= 0 then
        finish("curl exited with code " .. code)
      else
        finish(nil)
      end
    end,
    stdout_buffered = false,
  })

  if job_id <= 0 then
    vim.schedule(function()
      on_done("Failed to start curl")
    end)
    return function() end
  end

  return function()
    pcall(vim.fn.jobstop, job_id)
  end
end

return M
