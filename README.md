# pi-search

Web search and page reading for Pi Agent with Exa and DeepSeek.

## Install

```bash
pi install git:github.com/barkure/pi-search
```

## Configure

`~/.pi/agent/search.json`:

```json
{
  "providers": ["exa", "deepseek"],
  "mode": "fallback",
  "exaApiKey": "your-exa-key",
  "localFetch": true,
  "allowedAddresses": ["198.18.0.0/15"],
  "extractModel": "deepseek/deepseek-flash"
}
```

- `providers`: services and their order. DeepSeek reuses Pi's saved key.
- `mode`: `fallback` (default) uses one service at a time, moving to the next on failure or no results; `parallel` searches all and merges.
- `localFetch`: read pages from this machine when providers fail. Private addresses are refused unless listed in `allowedAddresses` (IPs or CIDR ranges; TUN proxies in fake-ip mode need `198.18.0.0/15`).
- `extractModel`: `provider/model-id` used by `web_fetch` with `prompt`; defaults to the current model.

## License

[MIT](LICENSE)
