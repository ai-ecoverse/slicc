import Foundation

/// Encoding-aware masked→real unmask for `application/x-www-form-urlencoded`
/// request bodies.
///
/// Mirrors `unmaskFormBody` in `packages/shared-ts/src/form-body-unmask.ts`;
/// the substitution table is pinned in both cross-impl test files.
///
/// A form body is text, so the naive path is a substring replace of the masked
/// token with the real value. That corrupts the body whenever the real secret
/// contains a character that is reserved in a form: `&` and `=` split one field
/// into two (or inject an extra parameter), `+` is decoded upstream as a space,
/// and a bare `%` becomes a malformed escape. Base64 secrets — AWS keys, many
/// OAuth client secrets — routinely contain `+`, `/`, and `=`, so the naive path
/// silently breaks exactly the token exchanges that made form unmasking
/// necessary in the first place.
///
/// Same shape as `SecretInjector.unmaskAuthorizationBasic`, which decodes
/// base64, unmasks, and re-encodes rather than substituting into the wire form.

/// The `encodeURIComponent` unreserved set. Everything else in a form value is
/// percent-escaped, which keeps the two implementations byte-identical.
private let formComponentAllowed = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
)

/// Percent-decode one form component. `+` means space in a form body, so it is
/// promoted to `%20` first. `nil` on a malformed escape — the caller treats that
/// as "cannot reason about this field's encoding".
private func decodeFormComponent(_ raw: String) -> String? {
    raw.replacingOccurrences(of: "+", with: "%20").removingPercentEncoding
}

/// Percent-encode one form component. Space becomes `%20` rather than `+`; both
/// decode to a space.
private func encodeFormComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: formComponentAllowed) ?? value
}

/// Unmask a form-urlencoded body field by field. Returns the input unchanged
/// when no field carried a masked token, so an untouched body keeps its bytes.
func unmaskFormBody(text body: String, hostname: String, injector: SecretInjector) -> String {
    if body.isEmpty || injector.isEmpty { return body }

    var changed = false
    let fields = body.components(separatedBy: "&").map { field -> String in
        let name: String
        let rawValue: String
        if let eq = field.firstIndex(of: "=") {
            name = String(field[field.startIndex...eq])
            rawValue = String(field[field.index(after: eq)...])
        } else {
            name = ""
            rawValue = field
        }
        if rawValue.isEmpty { return field }

        guard let decoded = decodeFormComponent(rawValue) else {
            // Malformed percent-escape: the field's encoding is not
            // interpretable, so fall back to the legacy substring replace
            // rather than dropping the secret. Best-effort — a reserved
            // character in the real value can still corrupt a field this broken.
            let replaced = injector.injectBody(text: rawValue, hostname: hostname)
            if replaced == rawValue { return field }
            changed = true
            return name + replaced
        }

        let replaced = injector.injectBody(text: decoded, hostname: hostname)
        if replaced == decoded { return field }
        changed = true
        return name + encodeFormComponent(replaced)
    }

    return changed ? fields.joined(separator: "&") : body
}
