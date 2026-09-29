-- Command registration only. All behaviour lives in lua/enchanted-map/.
if vim.g.loaded_enchanted_map then
  return
end
vim.g.loaded_enchanted_map = true

local function cmd(name, fn, opts)
  vim.api.nvim_create_user_command(name, fn, opts or {})
end

cmd("EnchantedDeclare", function(a)
  require("enchanted-map").declare_entry_point(a.args ~= "" and a.args or nil)
end, { nargs = "?", desc = "Declare the symbol under the cursor as a flow entry point" })

cmd("EnchantedOpen", function(a)
  require("enchanted-map").open_flow(a.args ~= "" and a.args or nil)
end, { nargs = "?", desc = "Open a flow" })

cmd("EnchantedDiff", function(a)
  require("enchanted-map").open_flow(a.args ~= "" and a.args or nil, "diff")
end, { nargs = "?", desc = "Open a flow's diff against the stored map" })

cmd("EnchantedStale", function(a)
  require("enchanted-map").open_flow(a.args ~= "" and a.args or nil, "stale")
end, { nargs = "?", desc = "Show which parts of a flow have drifted" })

cmd("EnchantedAccept", function(a)
  require("enchanted-map").accept_flow(a.args ~= "" and a.args or nil)
end, { nargs = "?", desc = "Accept the flow at the current revision" })

cmd("EnchantedCanvas", function()
  require("enchanted-map").open_canvas()
end, { desc = "Open the browser canvas" })

cmd("EnchantedStatus", function()
  require("enchanted-map").status()
end, { desc = "Show the resolved project root and known flows" })

cmd("EnchantedStop", function()
  require("enchanted-map").stop()
end, { desc = "Stop the analyzer sidecar" })
