# Vendored QR encoder

`qrcode-generator.js` is the upstream `qrcode-generator` 1.4.4 browser build from
https://unpkg.com/qrcode-generator@1.4.4/qrcode.js, by Kazuhiko Arase.

It is included to render pairing QR codes on the local bridge without adding a
runtime npm dependency. The original header is retained; the only local change
is the final `export default qrcode` statement for ESM interoperability.

The MIT license text is included in `qrcode-generator.LICENSE`.
