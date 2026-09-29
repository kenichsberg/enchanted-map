-- Headless Neovim test for the editor surface.
-- Run: nvim --headless -l test/nvim/run.lua <fixture-root>
local root = vim.fn.expand(arg[1])
local plugin = vim.fn.getcwd()

vim.opt.runtimepath:prepend(plugin)
vim.g.loaded_enchanted_map = nil
dofile(plugin .. "/plugin/enchanted-map.lua")

local em = require("enchanted-map")
local sidecar = require("enchanted-map.sidecar")
em.setup({ root = root })

local failures = {}
local checks = 0
local function check(name, cond, detail)
  checks = checks + 1
  if cond then
    io.stdout:write("  ok   " .. name .. "\n")
  else
    io.stdout:write("  FAIL " .. name .. (detail and ("  -- " .. tostring(detail)) or "") .. "\n")
    table.insert(failures, name)
  end
end

--- Run an RPC call synchronously for the test.
local function rpc(method, params, timeout)
  local done, result, err = false, nil, nil
  sidecar.request(method, params, function(e, r)
    err, result, done = e, r, true
  end)
  vim.wait(timeout or 120000, function()
    return done
  end, 50)
  return err, result
end

io.stdout:write("\nediting surface\n")

-- 1. The sidecar starts on demand and announces itself.
sidecar.ensure(root)
local ready = false
sidecar.when_ready(function()
  ready = true
end)
vim.wait(60000, function()
  return ready
end, 50)
check("sidecar starts on demand", ready, "no ready announcement")

local info = sidecar.ready_info() or {}
check("ready announcement carries a root", info.root ~= nil)

-- 2. Declare an entry point from the cursor.
vim.cmd.edit(root .. "/app.py")
local lnum = vim.fn.search("^def login", "w")
check("found the login definition", lnum > 0, "line " .. tostring(lnum))
vim.api.nvim_win_set_cursor(0, { lnum, 4 })
em.declare_entry_point("login")
vim.wait(20000, function()
  local _, res = rpc("flows", {}, 20000)
  return res and res.flows and #res.flows > 0
end, 200)
local err, flows = rpc("flows", {})
check("declare registered the entry point", not err and flows and vim.tbl_contains(flows.flows, "login"), vim.inspect(flows))

-- 3. Analyze, then open the flow in a buffer.
local aerr = rpc("analyze", { flow = "login" })
check("analyze succeeded", aerr == nil, aerr)

em.open_flow("login")
vim.wait(60000, function()
  return vim.bo.filetype == "enchanted-map"
end, 100)
check("flow opened in a buffer", vim.bo.filetype == "enchanted-map")

local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
local text = table.concat(lines, "\n")
check("buffer shows the flow header", text:match("flow login") ~= nil, lines[1])
check("buffer shows edges", text:match("login %-> audit") ~= nil)
check("buffer shows a guard on an edge", text:match("%[mfa%]") ~= nil, "no [mfa] label")
check("buffer shows the negated guard", text:match("%[!mfa%]") ~= nil)
check("buffer marks heuristic provenance", text:match("heuristic") ~= nil)

-- 4. Jump to source from the map buffer.
local map_buf = vim.api.nvim_get_current_buf()
local target_line
for i, l in ipairs(lines) do
  if l:match("login %-> notify") then
    target_line = i
    break
  end
end
check("found an edge line to jump from", target_line ~= nil)
if target_line then
  vim.api.nvim_win_set_cursor(0, { target_line, 0 })
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "x", false)
  vim.wait(2000, function()
    return vim.api.nvim_get_current_buf() ~= map_buf
  end, 50)
  local name = vim.api.nvim_buf_get_name(0)
  check("jumped into app.py", name:match("app%.py$") ~= nil, name)
  local cur = vim.api.nvim_win_get_cursor(0)[1]
  check("cursor landed on the call site", cur > 1, "line " .. cur)
end

-- 5. A jump to a vanished location is refused, not guessed.
local notified = {}
local orig = vim.notify
vim.notify = function(msg, lvl)
  table.insert(notified, msg)
  orig(msg, lvl)
end
em.jump_to({ file = "does-not-exist.py", line = 3, character = 0 })
check(
  "refuses a jump to a missing file",
  #notified > 0 and notified[#notified]:match("not found under") ~= nil,
  vim.inspect(notified)
)
notified = {}
em.jump_to({ file = "<ext>/builtins.pyi", line = 1, character = 0 })
check(
  "refuses a jump outside the project",
  #notified > 0 and notified[#notified]:match("outside the project") ~= nil,
  vim.inspect(notified)
)
vim.notify = orig

-- 5b. Root auto-detection. The rest of this file passes an explicit root via
--     setup(), which bypasses find_root entirely -- the exact path that failed
--     in real use, resolving to a directory with no config.
local saved_root = em.config.root
em.config.root = nil
vim.cmd.edit(root .. "/app.py")
local detected = vim.fn.resolve(em.root())
check(
  "auto-detects the project root from the buffer",
  detected == vim.fn.resolve(root),
  ("detected %s, wanted %s"):format(detected, vim.fn.resolve(root))
)
vim.cmd.edit(root .. "/senders.py")
check(
  "auto-detection is stable across buffers in the repo",
  vim.fn.resolve(em.root()) == vim.fn.resolve(root),
  em.root()
)
em.config.root = saved_root

-- 5c. The whole flow WITHOUT an explicit root -- the real-session path.
--     Everything above passes root via setup(), which hid two bugs: the map
--     buffer is named `enchanted://<flow>` and is not a file, so deriving a
--     root from it yields garbage and every jump fails.
local saved2 = em.config.root
em.config.root = nil
vim.cmd.edit(root .. "/app.py")
vim.cmd("EnchantedOpen login")
vim.wait(120000, function()
  return vim.bo.filetype == "enchanted-map"
end, 100)
check("opens a flow with no configured root", vim.bo.filetype == "enchanted-map")

local map_buf2 = vim.api.nvim_get_current_buf()
local lines2 = vim.api.nvim_buf_get_lines(0, 0, -1, false)
local senders_line
for i, l in ipairs(lines2) do
  if l:match("senders%.py") then
    senders_line = i
    break
  end
end
check("map lists a node in senders.py", senders_line ~= nil)

local notes2 = {}
local orig2 = vim.notify
vim.notify = function(m, lv)
  table.insert(notes2, m)
  orig2(m, lv)
end
if senders_line then
  vim.api.nvim_win_set_cursor(0, { senders_line, 0 })
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "x", false)
  vim.wait(3000, function()
    return vim.api.nvim_get_current_buf() ~= map_buf2
  end, 50)
end
vim.notify = orig2

local landed = vim.api.nvim_buf_get_name(0)
check(
  "jumps into senders.py without a configured root",
  landed:match("senders%.py$") ~= nil,
  ("landed on %s; notifications: %s"):format(landed, vim.inspect(notes2))
)
check(
  "no 'not found' refusal was issued",
  not vim.tbl_contains(
    vim.tbl_map(function(m)
      return m:match("cannot jump") ~= nil
    end, notes2),
    true
  ),
  vim.inspect(notes2)
)
em.config.root = saved2

-- 6. Accept the flow.
local accerr, accview = rpc("accept", { flow = "login" })
check("accept stamps the flow", accerr == nil and accview and accview.acceptance == "accepted", accerr)

-- 7. Shutdown leaves no process.
sidecar.shutdown()
vim.wait(3000, function()
  return not sidecar.running()
end, 50)
check("shutdown stops the sidecar", not sidecar.running())

io.stdout:write(("\n%d checks, %d failures\n"):format(checks, #failures))
if #failures > 0 then
  io.stdout:write("failed: " .. table.concat(failures, ", ") .. "\n")
  vim.cmd("cquit 1")
end
vim.cmd("qall!")
