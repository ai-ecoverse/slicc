# chrome-extension

Chrome extension (MV3) — thin CDP-bridge + bootstrapper. The service
worker proxies `chrome.debugger` to the hosted leader tab; the
content script injects the `<slicc-launcher>` overlay. The webapp UI
and agent engine load from `https://www.sliccy.ai/?slicc=leader`, not
from the bundled extension.
