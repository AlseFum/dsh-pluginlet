# Changelog

## 0.1.0

First published version. The unit is a **pluginlet**: one self-contained JavaScript file at
`<repo>/.dsh/pluginlets/<name>.pluginlet`, mounted as its own Conversation View tab.

### Features

- discovery of `.dsh/pluginlets/*.pluginlet` (configurable `directories` and `extensions`);
- three export shapes: component function, `{ setup }`, and imperative `{ mount(el, api) }`;
- mini React runtime in the sandbox (`api.h`, `Fragment`, five hooks) with positional patching;
- `api.fs.read` / `api.fs.list` / `api.write.request` / `api.net.fetch` / `api.ui.toast` /
  `api.access` proxied to the Host;
- static scan before load: capability and path extraction, blocked-construct rules, hashing;
- grants bound to `(workspace, path, sha256, capability → path scopes)`, stored under
  `$DSH_HOME/pluginlet/`, merged on runtime requests, revocable;
- approval dialog with per-capability path checkboxes and a per-content confirmation;
- confirmation dialog for writes, guarded by the version read;
- permission manager in the Plugins panel (`plugins.row.config`), with per-capability path editing;
- plugin `Config`: `devMode`, `extensions`, `directories`, caps, and a network budget;
- audit log (`audit.jsonl`, rotated at 2 MiB) with client-side phase events;
- packaged skill `pluginlet-development` so an agent can learn the contract after installing.

### Security

- sandbox: `sandbox="allow-scripts"` iframe, opaque origin, `default-src 'none'` CSP;
- the scanner is a policy gate; the sandbox is the boundary;
- host paths are contained lexically **and** canonically, so symlinks cannot escape the workspace;
- the network proxy rejects loopback/private literals, resolves and checks every address, and
  validates each redirect hop (residual DNS-rebinding risk is documented).
