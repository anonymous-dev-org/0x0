# js

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.12. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Prompt layering

Prompt composition follows this order only:

1. `system_prompt` (base prompt for all agents)
2. The selected agent's `prompt`
3. One active skill prompt (latest loaded skill)

Example `.0x0/config.yaml`:

```yaml
system_prompt: |
  You are 0x0. Be concise and accurate.

agent:
  plan:
    prompt: |
      Focus on planning, sequencing, and risk assessment.
```
