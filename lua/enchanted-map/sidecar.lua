-- Sidecar process lifetime and RPC.
--
-- Neovim spawns the sidecar and kills it on exit, so there is no port to
-- configure and no daemon to leak. Communication is newline-delimited JSON
-- over the process's own pipes.
local M = {}

local state = {
  proc = nil,
  buf = "",
  next_id = 0,
  pending = {},
  ready = nil, -- { port = number|nil, root = string, bindError = string|nil }
  on_ready = {},
  root = nil,
  failed = nil,
}

local function notify(msg, level)
  vim.notify("enchanted-map: " .. msg, level or vim.log.levels.INFO)
end

--- Nearest ancestor containing `.enchanted` or `.git`, else cwd.
function M.find_root(start)
  local from = start or vim.fn.getcwd()
  local found = vim.fs.find({ ".enchanted", ".git" }, { path = from, upward = true })[1]
  if found then
    return vim.fs.dirname(found)
  end
  return from
end

local function plugin_dir()
  local source = debug.getinfo(1, "S").source:sub(2)
  -- .../lua/enchanted-map/sidecar.lua -> plugin root
  return vim.fs.normalize(vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source))))
end

function M.command(root)
  local cfg = require("enchanted-map").config
  if cfg.sidecar_cmd then
    return cfg.sidecar_cmd
  end
  local cli = plugin_dir() .. "/src/cli.ts"
  return { "node", "--experimental-strip-types", cli, "serve", "--stdio", "--root", root }
end

local function dispatch(line)
  local ok, msg = pcall(vim.json.decode, line)
  if not ok or type(msg) ~= "table" then
    return
  end

  -- Unsolicited events carry id 0.
  if msg.event == "ready" then
    state.ready = msg.params or {}
    -- Root resolution is automatic and therefore invisible; announce it once
    -- so a wrong root is obvious instead of surfacing as "flow not analyzed".
    notify("analyzing " .. tostring(state.ready.root or "?"))
    for _, cb in ipairs(state.on_ready) do
      cb(state.ready)
    end
    state.on_ready = {}
    return
  end
  if msg.event == "jump" then
    require("enchanted-map").jump_to(msg.params)
    return
  end

  local entry = state.pending[msg.id]
  if not entry then
    return
  end
  state.pending[msg.id] = nil
  entry(msg.error, msg.result)
end

local function on_stdout(_, data)
  if not data then
    return
  end
  state.buf = state.buf .. data
  while true do
    local nl = state.buf:find("\n", 1, true)
    if not nl then
      return
    end
    local line = state.buf:sub(1, nl - 1)
    state.buf = state.buf:sub(nl + 1)
    if line ~= "" then
      vim.schedule(function()
        dispatch(line)
      end)
    end
  end
end

function M.running()
  return state.proc ~= nil
end

--- Start the sidecar if it is not already running.
function M.ensure(root)
  if state.proc then
    return state.proc
  end
  -- Default to the plugin's resolved root; find_root(getcwd()) would silently
  -- pick whatever directory nvim happened to start in.
  state.root = root or require("enchanted-map").root()
  state.failed = nil
  state.buf = ""

  local cmd = M.command(state.root)
  local ok, proc = pcall(vim.system, cmd, {
    stdin = true,
    stdout = on_stdout,
    stderr = function(_, data)
      if data and data ~= "" then
        state.failed = data
      end
    end,
    text = true,
  }, function(res)
    -- Exited.
    state.proc = nil
    local pending = state.pending
    state.pending = {}
    state.ready = nil
    for _, cb in pairs(pending) do
      cb("sidecar exited (code " .. tostring(res.code) .. ")", nil)
    end
    if res.code ~= 0 and res.code ~= nil then
      vim.schedule(function()
        notify(
          ("sidecar exited unexpectedly (code %s). Run the command again to retry.%s")
            :format(tostring(res.code), state.failed and ("\n" .. state.failed) or ""),
          vim.log.levels.ERROR
        )
      end)
    end
  end)

  if not ok then
    notify("could not start the sidecar: " .. tostring(proc), vim.log.levels.ERROR)
    return nil
  end
  state.proc = proc
  return proc
end

--- Run `cb` once the sidecar has announced itself.
function M.when_ready(cb)
  if state.ready then
    return cb(state.ready)
  end
  table.insert(state.on_ready, cb)
end

function M.ready_info()
  return state.ready
end

--- Send a request. `cb(err, result)`.
function M.request(method, params, cb)
  local proc = M.ensure()
  if not proc then
    return cb("sidecar is not running", nil)
  end
  state.next_id = state.next_id + 1
  local id = state.next_id
  state.pending[id] = cb
  local line = vim.json.encode({ id = id, method = method, params = params or vim.empty_dict() })
  local ok, err = pcall(function()
    proc:write(line .. "\n")
  end)
  if not ok then
    state.pending[id] = nil
    cb("could not write to the sidecar: " .. tostring(err), nil)
  end
end

function M.shutdown()
  local proc = state.proc
  state.proc = nil
  state.pending = {}
  state.ready = nil
  if proc then
    pcall(function()
      proc:kill("sigterm")
    end)
  end
end

return M
