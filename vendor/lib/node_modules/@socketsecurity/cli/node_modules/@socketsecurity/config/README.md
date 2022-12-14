# Socket Config

[![npm version](https://img.shields.io/npm/v/@socketsecurity/config.svg?style=flat)](https://www.npmjs.com/package/@socketsecurity/config)
[![js-standard-style](https://img.shields.io/badge/code%20style-standard-brightgreen.svg)](https://github.com/SocketDev/eslint-config)
[![Types in JS](https://img.shields.io/badge/types_in_js-yes-brightgreen)](https://github.com/voxpelli/types-in-js)
[![Follow @SocketSecurity](https://img.shields.io/twitter/follow/SocketSecurity?style=social)](https://twitter.com/SocketSecurity)

Reader/parser/validator tool for [Socket.dev](https://socket.dev/)'s [`socket.yml`](https://docs.socket.dev/docs/socket-yml) configuration files

## Usage

```bash
npm install @socketsecurity/config
```

```javascript
import { readSocketConfig } from '@socketsecurity/config'

const config = await readSocketConfig('socket.yml')
```

## Exports

### `readSocketConfig(<path-to-config-file>)`

Returns a `Promise` that resolves to the parsed config file or, if no such file was found, it fails silently and returns `undefined`.

If the config file can't be read, then the `Promise` will be rejected with an error.

The read file is parsed using `parseSocketConfig`and the `Promise` from there is what is ultimately returned when no rejection or resolve has been made already.

### `parseSocketConfig(<content-of-config-file>)`

Returns a `Promise` that resolves to the parsed config.

If the config content can't be parsed or it is invalid, then the `Promise` will be rejected with an error.

Any additional parameters that does not conform to the schema will be silently dropped. Also: Input data will be coerced into its intended shape when possible.

### `socketYmlSchema`

A JSON Schema object typed with [`JSONSchemaType<SocketYml>`](https://ajv.js.org/guide/typescript.html) from Ajv

### `SocketValidationError`

Error thrown when the parsed data doesn't conform to the JSON Schema definition.

Extends `Error` and adds these additional properties:

* `data` – the data that's found to be invalid
* `schema` – the schema used to validate the content
* `validationErrors` – an array of [Ajv's `ErrorObject`](https://ajv.js.org/api.html#error-objects)

## Type exports

This module has full type coverage through a [types in js](https://github.com/voxpelli/types-in-js) where TypeScript validates JSDoc annotated javascript and exports it as standard type definition files.

### `SocketYml`

A TypeScript type representing the shape of the parsed `socket.yml` config

## Used by

* [`@socketsecurity/cli`](https://github.com/SocketDev/socket-cli-js) - our CLI uses this to parse the Socket config

## See also

* [Socket.yml reference](https://docs.socket.dev/docs/socket-yml) - the config parsed by this module
