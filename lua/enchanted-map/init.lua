-- Public API for the Neovim surface.
--
-- The editor renders view objects produced by the sidecar; it never computes
-- its own representation, so it cannot drift from the browser canvas.
local M = {}

local sidecar = require("enchanted-map.sidecar")

M.config = {
  sidecar_cmd = nil, -- resolved at spawn time
  root = nil, -- resolved from the buffer when nil
}

--- Buffer-local state for a rendered flow: line number -> jump target.
local rendered = {}

local function notify(msg, level)
  vim.notify("enchanted-map: " .. msg, level or vim.log.levels.INFO)
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
end

--- Resolve the project root.
---
--- Only a real file buffer can say where we are. The map buffer is a scratch
--- buffer named `enchanted://<flow>`, and expanding that as a path yields
--- garbage -- which is how a jump ends up resolving against the wrong
--- directory and reporting a file that plainly exists as missing.
function M.root()
  if M.config.root then
    return M.config.root
  end
  local name = vim.api.nvim_buf_get_name(0)
  local from
  if vim.bo.buftype == "" and name ~= "" and not name:match("^%a[%w%+%-%.]*://") then
    from = vim.fn.fnamemodify(name, ":p:h")
  else
    from = vim.fn.getcwd()
  end
  return sidecar.find_root(from)
end

--- Report the resolved root and what the sidecar knows about it.
function M.status()
  local root = M.root()
  notify("root: " .. root)
  sidecar.ensure(root)
  sidecar.request("flows", {}, function(err, res)
    if err then
      return notify(err, vim.log.levels.ERROR)
    end
    local flows = (res or {}).flows or {}
    if #flows == 0 then
      notify(
        "no flows declared in " .. root .. "\n"
          .. "Use :EnchantedDeclare with the cursor on a function.",
        vim.log.levels.WARN
      )
    else
      notify("flows: " .. table.concat(flows, ", "))
    end
  end)
end

local function relative(path, root)
  local abs = vim.fs.normalize(vim.fn.fnamemodify(path, ":p"))
  root = vim.fs.normalize(root)
  if abs:sub(1, #root + 1) == root .. "/" then
    return abs:sub(#root + 2)
  end
  return abs
end

--- Symbol under the cursor, preferring the enclosing definition name.
local function symbol_at_cursor()
  local ok, node = pcall(vim.treesitter.get_node)
  if ok and node then
    local cur = node
    while cur do
      local t = cur:type()
      if t == "function_definition" or t == "class_definition" then
        local name = cur:field("name")[1]
        if name then
          return vim.treesitter.get_node_text(name, 0)
        end
      end
      cur = cur:parent()
    end
  end
  local word = vim.fn.expand("<cword>")
  return word ~= "" and word or nil
end

-- ------------------------------------------------------------------ commands

function M.declare_entry_point(name)
  local root = M.root()
  local file = relative(vim.fn.expand("%:p"), root)
  local symbol = symbol_at_cursor()
  if not symbol then
    return notify("no symbol under the cursor", vim.log.levels.WARN)
  end
  sidecar.ensure(root)
  sidecar.request("declare", { name = name or symbol, file = file, symbol = symbol }, function(err)
    if err then
      return notify(err, vim.log.levels.ERROR)
    end
    notify(("declared '%s' -> %s:%s"):format(name or symbol, file, symbol))
  end)
end

local function render_flow(view)
  local lines = {}
  local targets = {}
  local label = {}
  for _, n in ipairs(view.nodes or {}) do
    label[n.id] = n.label
  end

  local function push(text, target)
    table.insert(lines, text)
    targets[#lines] = target
  end

  push(("flow %s  [%s]  depth=%d"):format(view.flow, view.acceptance, view.maxDepth))
  push(
    ("  %d nodes · %d edges · %d holes · %d stale"):format(
      view.counts.nodes,
      view.counts.edges,
      view.counts.holes,
      view.counts.stale
    )
  )
  push("")

  for _, e in ipairs(view.edges or {}) do
    local marks = {}
    if e.provenance ~= "lsp-verified" then
      table.insert(marks, e.provenance)
    end
    if e.closesCycle then
      table.insert(marks, "cycle")
    end
    if e.stale then
      table.insert(marks, "stale")
    end
    local text = ("  %s -> %s"):format(label[e.from] or e.from, label[e.to] or e.to)
    if e.conditionLabel ~= "" then
      text = text .. ("  [%s]"):format(e.conditionLabel)
    end
    if #marks > 0 then
      text = text .. ("  (%s)"):format(table.concat(marks, ","))
    end
    push(text, { file = e.file, line = e.line, character = 0 })
  end

  if #(view.holes or {}) > 0 then
    push("")
    push(("unresolved dispatch (%d):"):format(#view.holes))
    for _, h in ipairs(view.holes) do
      push(("  %s  %s  %d candidates"):format(h.declaredTarget, h.reason, #h.candidates))
    end
  end

  push("")
  push("nodes:")
  for _, n in ipairs(view.nodes or {}) do
    local flags = {}
    if n.external then
      table.insert(flags, "external")
    end
    if n.truncated then
      table.insert(flags, "truncated")
    end
    if n.cycle then
      table.insert(flags, "cycle")
    end
    if n.stale then
      table.insert(flags, "stale")
    end
    local suffix = #flags > 0 and ("  (%s)"):format(table.concat(flags, ",")) or ""
    push(
      ("  %-28s %s:%d%s"):format(n.label, n.file, (n.line or 0) + 1, suffix),
      n.external and nil or { file = n.file, line = n.line, character = 0 }
    )
  end

  return lines, targets
end

local function show(view, root)
  local lines, targets = render_flow(view)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].filetype = "enchanted-map"
  vim.bo[buf].bufhidden = "wipe"
  rendered[buf] = { targets = targets, root = root }
  -- Opening the same flow twice in a session is the normal case (re-open
  -- after an edit). nvim_buf_set_name throws if the name is taken, so retire
  -- the previous map for this flow first.
  local bufname = "enchanted://" .. view.flow
  local existing = vim.fn.bufnr(bufname)
  if existing ~= -1 and existing ~= buf then
    rendered[existing] = nil
    pcall(vim.api.nvim_buf_delete, existing, { force = true })
  end
  pcall(vim.api.nvim_buf_set_name, buf, bufname)

  vim.keymap.set("n", "<CR>", function()
    local lnum = vim.api.nvim_win_get_cursor(0)[1]
    local entry = rendered[buf]
    local target = entry and entry.targets[lnum]
    if target then
      -- Use the root this map was built from, not whatever is focused now.
      M.jump_to(target, entry.root)
    end
  end, { buffer = buf, desc = "Jump to this node's source" })
  vim.keymap.set("n", "q", "<cmd>close<cr>", { buffer = buf, desc = "Close" })

  vim.cmd.split()
  vim.api.nvim_win_set_buf(0, buf)
  return buf
end

function M.open_flow(name, lens)
  local root = M.root()
  sidecar.ensure(root)
  local function go(flow)
    sidecar.request("view", { flow = flow, lens = lens or "flow" }, function(err, view)
      if err then
        return notify(err, vim.log.levels.ERROR)
      end
      show(view, root)
    end)
  end
  if name then
    return go(name)
  end
  sidecar.request("flows", {}, function(err, res)
    if err then
      return notify(err, vim.log.levels.ERROR)
    end
    local flows = (res or {}).flows or {}
    if #flows == 0 then
      return notify("no flows declared. Use :EnchantedDeclare first.", vim.log.levels.WARN)
    end
    if #flows == 1 then
      return go(flows[1])
    end
    vim.ui.select(flows, { prompt = "Flow" }, function(choice)
      if choice then
        go(choice)
      end
    end)
  end)
end

function M.accept_flow(name)
  sidecar.ensure(M.root())
  local function go(flow)
    sidecar.request("accept", { flow = flow }, function(err, view)
      if err then
        return notify(err, vim.log.levels.ERROR)
      end
      notify(("accepted '%s' at %s"):format(view.flow, view.acceptedRevision or "unversioned"))
    end)
  end
  if name then
    return go(name)
  end
  sidecar.request("flows", {}, function(err, res)
    if err then
      return notify(err, vim.log.levels.ERROR)
    end
    local flows = (res or {}).flows or {}
    if #flows == 1 then
      return go(flows[1])
    end
    vim.ui.select(flows, { prompt = "Accept flow" }, function(choice)
      if choice then
        go(choice)
      end
    end)
  end)
end

--- Open a node's source location. Refuses rather than guessing.
---
--- `root` is the project the target belongs to. A jump pushed from the browser
--- carries the sidecar's own root; a jump from a map buffer carries the root
--- that map was built from. Falling back to M.root() is a last resort.
function M.jump_to(target, root)
  if not target or not target.file then
    return notify("no jump target", vim.log.levels.WARN)
  end
  if target.file:sub(1, 5) == "<ext>" then
    return notify("that symbol is outside the project", vim.log.levels.WARN)
  end
  local base = target.root or root or M.root()
  local path = vim.fs.normalize(base .. "/" .. target.file)
  if vim.fn.filereadable(path) ~= 1 then
    return notify(
      ("cannot jump: %s not found under %s"):format(target.file, base),
      vim.log.levels.WARN
    )
  end
  local line = (target.line or 0) + 1
  local total = #vim.fn.readfile(path)
  if line > total then
    return notify(
      ("cannot jump: %s has only %d lines"):format(target.file, total),
      vim.log.levels.WARN
    )
  end
  -- Jump in the previous window when the map buffer is focused.
  if vim.bo.filetype == "enchanted-map" then
    vim.cmd.wincmd("p")
  end
  vim.cmd.edit(vim.fn.fnameescape(path))
  vim.api.nvim_win_set_cursor(0, { line, target.character or 0 })
  vim.cmd("normal! zz")
end

function M.open_canvas()
  sidecar.ensure(M.root())
  sidecar.when_ready(function(info)
    if not info.port then
      return notify(
        "the canvas could not bind a port" .. (info.bindError and (": " .. info.bindError) or ""),
        vim.log.levels.WARN
      )
    end
    local url = ("http://127.0.0.1:%d/"):format(info.port)
    notify("canvas at " .. url)
    pcall(vim.ui.open, url)
  end)
end

function M.stop()
  sidecar.shutdown()
  notify("sidecar stopped")
end

-- The sidecar must not outlive the editor.
vim.api.nvim_create_autocmd("VimLeavePre", {
  group = vim.api.nvim_create_augroup("EnchantedMapShutdown", { clear = true }),
  callback = function()
    sidecar.shutdown()
  end,
})

return M
