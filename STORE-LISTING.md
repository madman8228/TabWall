# TabWall store listing

## Name

TabWall

## Short description

Save tabs locally, close unused pages to help reduce memory use, and restore them whenever you need.

## Full description

TabWall turns a crowded browser window into a compact tab wall. Save the web tabs in the current window, close the pages you are not using to help reduce memory use, and restore one tab or the whole collection whenever you are ready.

### Features

- Save the current window's ordinary web tabs with their titles, URLs, favicons, order, and timestamps.
- Use the right-click menu to save a single page to TabWall.
- Restore one tab or restore the complete collection to the browser.
- Restore all tabs lazily so pages load when you select them instead of loading every website at once.
- Switch between original order and grouping by website.
- Drag cards to reorder them in the original view.
- Choose how many cards appear in each row.
- Keep regular browsing and InPrivate sessions separate.
- Store data locally without an account, server, cloud sync, analytics, or remote code.

TabWall is designed to be a focused, lightweight alternative to leaving dozens of browser tabs open.

## Permission explanation

- `tabs`: read the current window's tab title, URL, favicon, order, and access time, and create or restore tabs.
- `storage`: save sessions and preferences locally in the browser.
- `contextMenus`: add the “Save current page to TabWall” page menu item.
- InPrivate access: run the extension in InPrivate when the user explicitly allows it; regular and InPrivate sessions are stored separately.

## Certification notes

1. Install the extension and click the toolbar icon while ordinary web pages are open.
2. The manager page should show the saved tabs.
3. Click an individual card to restore one tab.
4. Click “Restore all” to create browser tabs; each page loads when selected.
5. Use the page context menu to save one page.
6. To test InPrivate, enable “Allow in InPrivate” in the browser extension details, then repeat the save flow in an InPrivate window.

No account or test credentials are required.

## Privacy policy URL

`https://madman8228.github.io/TabWall/privacy-policy.html`

## Support URL

`https://github.com/madman8228/TabWall/issues`
