import Foundation

/// CDP `Input.dispatchKeyEvent` → injected DOM events for a WKWebView target.
///
/// WKWebView does not run Chrome's implicit form submit for a synthetic
/// `KeyboardEvent` that only sets `key`. The constructor also ignores the
/// deprecated `keyCode`/`which` init fields, so those must be defined on the
/// event object. Leader payloads after the playwright-cli Enter fix include
/// `windowsVirtualKeyCode` and keyDown `text` (`'\r'` for Enter); dropping
/// either reproduces the silent no-op that left `keyCode === 0`.
enum CDPInputDomain {
    static func dispatchKeyEventJavaScript(_ params: [String: Any]) -> String {
        let type = (params["type"] as? String) ?? ""
        switch type {
        case "char":
            return insertTextJavaScript(text: (params["text"] as? String) ?? "")
        default:
            return keyEventJavaScript(params: params, type: type)
        }
    }

    static func insertTextJavaScript(text: String) -> String {
        """
        (function() {
          var el = document.activeElement;
          var text = \(jsLiteral(text));
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
            if (el.value !== undefined) { el.value += text; }
            else { el.textContent += text; }
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
          }
          return false;
        })()
        """
    }

    /// DOM `keyCode`/`which` come from `windowsVirtualKeyCode` (the Windows VK
    /// / Chrome value). `nativeVirtualKeyCode` is platform-native (macOS
    /// Return is 36) and must not stand in for it — same rule as
    /// `playwright/keyboard.ts`.
    static func keyCode(from params: [String: Any]) -> Int {
        if let code = intValue(params["windowsVirtualKeyCode"]) { return code }
        let key = (params["key"] as? String) ?? ""
        switch key {
        case "Enter", "Return", "\r", "\n": return 13
        case "Tab": return 9
        case "Escape", "Esc": return 27
        case "Backspace": return 8
        case "Delete": return 46
        default:
            guard key.utf16.count == 1, let unit = key.utf16.first else { return 0 }
            return Int(unit)
        }
    }

    private static func keyEventJavaScript(params: [String: Any], type: String) -> String {
        let evt: String
        switch type {
        case "keyDown", "rawKeyDown": evt = "keydown"
        case "keyUp": evt = "keyup"
        default: evt = type
        }
        let key = (params["key"] as? String) ?? ""
        let code = (params["code"] as? String) ?? ""
        let text = (params["text"] as? String) ?? ""
        let keyCode = keyCode(from: params)
        let isEnter = keyCode == 13 || key == "Enter" || text == "\r" || text == "\n"
        // CDP `rawKeyDown` is the key-down without a char/text phase; do not
        // synthesize keypress or implicit submit for it.
        let emitKeypress = type == "keyDown" && (isEnter || !text.isEmpty)
        let submitOnEnter = type == "keyDown" && isEnter
        return """
            (function() {
              var el = document.activeElement || document.body;
              var key = \(jsLiteral(key));
              var code = \(jsLiteral(code));
              var text = \(jsLiteral(text));
              var keyCode = \(keyCode);
              function make(type, charCode) {
                var init = {bubbles:true, cancelable:true, key:key};
                if (code) init.code = code;
                var ev = new KeyboardEvent(type, init);
                try {
                  Object.defineProperty(ev, 'keyCode', {get: function() { return keyCode; }});
                  Object.defineProperty(ev, 'which', {get: function() { return keyCode; }});
                  if (charCode != null) {
                    Object.defineProperty(ev, 'charCode', {get: function() { return charCode; }});
                  }
                } catch (e) {}
                return ev;
              }
              var cancelled = !el.dispatchEvent(make(\(jsLiteral(evt)), null));
              \(emitKeypress ? keypressAndMaybeSubmitJavaScript(submitOnEnter: submitOnEnter) : "")
              return true;
            })()
            """
    }

    private static func keypressAndMaybeSubmitJavaScript(submitOnEnter: Bool) -> String {
        let submit =
            submitOnEnter
            ? """
                if (!cancelled && el.tagName === 'INPUT') {
                  var form = el.form || (el.closest && el.closest('form'));
                  if (form) {
                    var blocking = {text:1,search:1,url:1,tel:1,email:1,password:1,date:1,month:1,week:1,time:1,'datetime-local':1,number:1};
                    var elType = (el.type || 'text').toLowerCase();
                    if (blocking[elType]) {
                      var defaultBtn = null;
                      var nodes = form.querySelectorAll('button, input');
                      for (var i = 0; i < nodes.length; i++) {
                        var n = nodes[i];
                        if (n.disabled) continue;
                        var nt = (n.getAttribute('type') || (n.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase();
                        if (n.tagName === 'BUTTON' && nt !== 'submit') continue;
                        if (n.tagName === 'INPUT' && nt !== 'submit' && nt !== 'image') continue;
                        defaultBtn = n;
                        break;
                      }
                      if (defaultBtn) {
                        if (typeof form.requestSubmit === 'function') form.requestSubmit(defaultBtn);
                        else defaultBtn.click();
                      } else {
                        var count = 0;
                        var inputs = form.querySelectorAll('input');
                        for (var j = 0; j < inputs.length; j++) {
                          var t = (inputs[j].type || 'text').toLowerCase();
                          if (blocking[t] && !inputs[j].disabled) count++;
                        }
                        if (count <= 1) {
                          if (typeof form.requestSubmit === 'function') form.requestSubmit();
                          else form.submit();
                        }
                      }
                    }
                  }
                }
            """
            : ""
        return """
              if (!cancelled) {
                cancelled = !el.dispatchEvent(make('keypress', text ? text.charCodeAt(0) : 13));
              }
              \(submit)
            """
    }

    /// JSON string literal, including quotes, so CR/LF/quotes survive interpolation.
    static func jsLiteral(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
            let wrapped = String(data: data, encoding: .utf8),
            wrapped.count >= 4
        else { return "\"\"" }
        return String(wrapped.dropFirst().dropLast())
    }

    static func intValue(_ raw: Any?) -> Int? {
        switch raw {
        case let value as Int: return value
        case let value as Int64: return Int(value)
        case let value as Double: return Int(value)
        case let value as NSNumber: return value.intValue
        default: return nil
        }
    }
}
