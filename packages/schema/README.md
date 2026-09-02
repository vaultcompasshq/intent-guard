# @vaultcompass/intent-guard-schema

Intent Contract JSON Schema, TypeScript types, and AJV validation for [Intent Guard](https://github.com/vaultcompasshq/intent-guard).

> Renamed in 1.2.0. This package was published as
> `@vaultcompass/conductor-schema` through 1.1.0. Update the import specifier;
> the schema and the exported API are unchanged.

## Install

```bash
npm install @vaultcompass/intent-guard-schema
```

## Usage

```typescript
import { validateIntentContract } from "@vaultcompass/intent-guard-schema";

const result = validateIntentContract(contractObject);
if (!result.valid) console.error(result.errors);
```

The Intent Contract schema version field is **`1.0.0`** (YAML document version). See [stability policy](https://github.com/vaultcompasshq/intent-guard/blob/main/docs/release/stability-policy.md).

## License

MIT
