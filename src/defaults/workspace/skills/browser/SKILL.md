---
name: browser
description: Browse the web, interact with pages, take screenshots, extract data. The browser tool provides playwright-style automation.
allowed-tools: browser
---

# Web Browser Automation

Use the `browser` tool to interact with web pages.

## Available Actions

- **navigate**: Go to a URL
  ```json
  { "action": "navigate", "url": "https://example.com" }
  ```

- **screenshot**: Capture the page
  ```json
  { "action": "screenshot" }
  ```

- **click**: Click an element
  ```json
  { "action": "click", "selector": "button.submit" }
  ```

- **type**: Enter text
  ```json
  { "action": "type", "selector": "input[name=email]", "text": "user@example.com" }
  ```

- **evaluate**: Run JavaScript
  ```json
  { "action": "evaluate", "code": "document.title" }
  ```

- **accessibility**: Get accessibility tree for understanding page structure

## Workflow

1. Navigate to the page
2. Take a screenshot or get accessibility tree to understand the page
3. Interact with elements
4. Repeat as needed
