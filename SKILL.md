---
allowed-tools: mcp__garage-assistant__screenshot, mcp__garage-assistant__click, mcp__garage-assistant__double_click, mcp__garage-assistant__right_click, mcp__garage-assistant__type_text, mcp__garage-assistant__press_key, mcp__garage-assistant__scroll, mcp__garage-assistant__get_window_info, mcp__garage-assistant__wait
when_to_use: When the user wants to interact with Garage Assistant 4, GA4, FileMaker, the garage software, vehicle records, repair orders, customer records, parts, invoicing, or anything related to the auto shop management system running in Parallels/Windows
---

# Garage Assistant 4 — Computer Control

You can see and control Garage Assistant 4 (a FileMaker-based auto shop management system running in Parallels on Windows). Follow these rules carefully.

## Core Workflow

1. **Always screenshot first** — before any action, take a screenshot to see the current state
2. **Identify coordinates** — look at the screenshot to find buttons, fields, tabs, menus
3. **Click precisely** — use the coordinates you identified (relative to the VM window)
4. **Wait after actions** — FileMaker can be slow. Wait 500-2000ms after navigation
5. **Screenshot to verify** — after every action, take another screenshot to confirm it worked

## Coordinate System

- Screenshots are captured directly from the VM at **1200 × ~820 pixels**
- Coordinates for clicking correspond to pixel positions in the screenshot image
- (0, 0) = top-left corner of the screenshot, (1200, 820) = bottom-right
- The coordinate mapping is automatic — just click where you see things in the screenshot
- Screenshots work even if other Mac windows are covering Parallels

## FileMaker-Specific Tips

- **Navigation**: FileMaker uses a tab/layout-based UI. Look for navigation bars, tabs, or sidebar menus
- **Fields**: Click directly on a field to focus it, then use `type_text`. If the field has existing text, use `ctrl+a` to select all first, then type to replace
- **Records**: Use arrow buttons or navigation controls (usually at top/bottom) to move between records
- **Portals**: Scrollable lists within a layout — scroll inside them with the `scroll` tool
- **Dropdown fields**: Click the field, wait for the dropdown to appear, then click the option
- **Date fields**: Click, select all (ctrl+a), type the date in the expected format
- **Find mode**: FileMaker uses ctrl+f to enter Find mode, then Enter to perform the find
- **Save**: Records usually auto-save on navigation, but ctrl+s works too

## Keyboard Shortcuts (Windows/Parallels)

- `ctrl+n` — New record
- `ctrl+f` — Find mode
- `ctrl+d` — Duplicate record
- `ctrl+s` — Save / Commit record
- `ctrl+z` — Undo
- `ctrl+p` — Print
- `tab` — Next field
- `shift+tab` — Previous field
- `escape` — Cancel / Exit current mode
- `return` or `enter` — Confirm / Execute find

## Safety Rules

- **Never delete records** unless the user explicitly asks and confirms
- **Always verify** you're on the correct record before modifying data
- **Take a screenshot** before and after any data modification to create an audit trail
- If something looks wrong or unexpected, **stop and ask the user** before proceeding

## Common Tasks

### Looking up a vehicle/customer
1. Screenshot to see current state
2. Navigate to the appropriate layout (Customers, Vehicles, etc.)
3. Enter Find mode (ctrl+f)
4. Type search criteria in the relevant field
5. Press Enter to perform the find
6. Screenshot to show results

### Creating a repair order
1. Navigate to the Work Orders / Repair Orders layout
2. Create new record (ctrl+n or click New button)
3. Fill in fields: customer, vehicle, date, description
4. Tab between fields
5. Screenshot to verify

### Entering parts/line items
1. Navigate to the line items area (usually a portal at the bottom of an RO)
2. Click in the first empty row
3. Enter part number, description, quantity, price
4. Tab to move between columns
