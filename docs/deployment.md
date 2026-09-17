# Deploying for several users

Two supported targets: **Docker on a Linux VM** and **IIS on Windows**. Both run
the application as **one Node process** (plus nginx in the Docker case).

There is **no sign-in**. Anyone who can reach the URL can use the app, so the
access control is where you put it: an internal network, a VPN, or a firewall
rule. Results are bound to the browser that created them (a session cookie that
ends when the browser closes), so one person's reconciliation is not fetchable by
another, and a later visit starts clean. That is isolation, not authentication.

## Before either target

- **One instance only.** Uploads, finished runs and running jobs live in this
  process's memory. Two replicas behind a load balancer break file lookups,
  progress polling and downloads. Scale up (more RAM and CPU), not out.
- **Nothing is persisted.** A restart — deploy, crash, reboot — clears uploads,
  results and in-flight comparisons. Users re-upload and re-run. There is no
  database and nothing to back up.
- **Memory is the real limit.** It decides how large a file the deployment can
  handle, because the heap, the upload cache and the upload cap all follow it:

  | Memory given to Node | Upload cache budget | Per-file upload cap  |
  | -------------------- | ------------------- | -------------------- |
  | 512 MB               | ~65 MB              | ~32 MB               |
  | 2 GB (default)       | ~500 MB             | ~140 MB              |
  | 4 GB                 | ~1 GB               | 200 MB (the ceiling) |

  Those are the defaults deriving themselves from the machine; `MAX_CACHE_BYTES`
  and `MAX_UPLOAD_BYTES` override them.

- **Concurrency.** `MAX_CONCURRENT_COMPARISONS` (default 3) comparisons run at
  once; the rest queue for `COMPARE_QUEUE_TIMEOUT_S` (default 120) and then get a
  503 telling them to retry. Each running comparison is a worker thread using a
  core and holding its own working set, so keep it at or below the core count and
  sized against the memory table above.
- **Retention.** `MAX_CACHED_RUNS` (default 50) finished results are kept, newest
  first. When it overflows, the oldest result is dropped and its download link
  stops working. Raise it for a busier instance; each entry holds that run's
  differences, so very large results cost more.
- **Rate limits** are per client and configurable: `RATE_LIMIT_WINDOW_S`
  (default 60) with `UPLOAD_RATE_LIMIT` (30), `COMPARE_RATE_LIMIT` (10) and
  `DOWNLOAD_RATE_LIMIT` (20). The defaults suit a handful of people sharing
  an instance; 10 comparisons a minute is easy to meet when someone is
  iterating on settings, so raise it if users report "Rate limit exceeded".
  They are keyed per client address, so `TRUST_PROXY` must match the
  deployment or everyone shares one bucket. Read once at startup.
- **Check it after deploying:** `GET /api/readyz` reports readiness, cache sizes
  and live memory against the budget. It is the one endpoint to look at when
  something is slow or failing.

---

## Docker on a Linux VM

The shipped Compose file already handles the things that usually break: uploads
up to 210 MB through nginx, 600-second proxy timeouts, unbuffered (streaming)
downloads, `X-Forwarded-For`, health checks and restart-on-failure.

### 1. Configure

Put a `.env` beside `docker-compose.yml`:

```dotenv
MEM_LIMIT=4g
MAX_CONCURRENT_COMPARISONS=3
MAX_CACHED_RUNS=50
LOG_LEVEL=info
# One proxy hop = the bundled nginx. Add one per extra proxy in front.
TRUST_PROXY=1
```

### 2. Run

```bash
docker compose up --build -d
docker compose ps
curl -I http://localhost:8080/            # SPA shell -> 200
curl http://localhost:8080/api/readyz     # readiness + memory
```

### 3. Terminate TLS in front

Nothing in the stack serves HTTPS. Put a TLS terminator ahead of the nginx
container — Caddy, another nginx, or the VM's load balancer — forwarding to
`127.0.0.1:8080`. **Each extra proxy is another hop: set `TRUST_PROXY` to match**,
or rate limiting keys on the wrong address.

Whatever terminates TLS must also allow large uploads and slow downloads:

- a body limit at or above `MAX_UPLOAD_BYTES` plus a megabyte of multipart slack;
- read/send timeouts of several minutes (a 75 MB workbook takes a while);
- response buffering off, so downloads stream.

### 4. Upgrading

```bash
git pull
docker compose up --build -d
```

In-flight comparisons are lost; users re-run them.

---

## IIS on Windows

IIS does not host Node. The backend runs as a **Windows Service** in
single-process mode (it serves the built Angular app and the API together), and
IIS sits in front as a reverse proxy for TLS, host names and logging.

> The IIS steps below have not been exercised on a live IIS box from this repo;
> treat them as the intended shape and verify each one during the first
> deployment, especially the four defaults called out under "Settings that
> silently break things".

### 1. Build on the server

```powershell
npm run setup
npm run build
```

### 2. Run the backend as a service

Using [nssm](https://nssm.cc/) (winsw or node-windows work equally well):

```powershell
nssm install FileReconciliation "C:\Program Files\nodejs\node.exe" `
  "C:\apps\compare_file\backend\dist\server.js" --serve-frontend
nssm set FileReconciliation AppDirectory "C:\apps\compare_file"
nssm set FileReconciliation AppEnvironmentExtra `
  PORT=3000 `
  SERVE_FRONTEND=1 `
  TRUST_PROXY=1 `
  MAX_CONCURRENT_COMPARISONS=3 `
  MAX_CACHED_RUNS=50 `
  NODE_OPTIONS=--max-old-space-size=3072
nssm start FileReconciliation
```

`NODE_OPTIONS=--max-old-space-size` matters here. In Docker the container's
memory limit bounds the heap; on Windows there is no such limit, so V8 sizes
itself from the machine's RAM and the cache budget follows. Set it deliberately —
it is the Windows equivalent of `MEM_LIMIT`.

Confirm the service is serving before involving IIS:

```powershell
Invoke-WebRequest http://localhost:3000/api/readyz | Select-Object -Expand Content
```

### 3. Put IIS in front

Install **Application Request Routing** and **URL Rewrite**, then enable proxying
(IIS Manager → server node → Application Request Routing Cache → Server Proxy
Settings → _Enable proxy_).

Create a site bound to your host name and certificate, pointing at an empty
folder, with this `web.config`:

```xml
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="ToNode" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://localhost:3000/{R:1}" />
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <!-- Bytes. Keep at or above MAX_UPLOAD_BYTES plus multipart slack.
             IIS's own default is ~28.6 MB and rejects larger uploads before
             they ever reach Node. -->
        <requestLimits maxAllowedContentLength="220200960" />
      </requestFiltering>
    </security>
  </system.webServer>
</configuration>
```

### Settings that silently break things

Verify each of these on the box:

| Setting                   | Default              | Symptom if left alone                                       | Fix                                                        |
| ------------------------- | -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `maxAllowedContentLength` | ~28.6 MB             | Large uploads fail with 404.13 before reaching Node         | Raise as above                                             |
| ARR response buffering    | On                   | Workbook downloads appear to hang, then arrive at once      | Server Proxy Settings → response buffer threshold `0`      |
| ARR proxy timeout         | ~120 s               | Long downloads cut off mid-file                             | Raise to several minutes                                   |
| `X-Forwarded-For`         | Not always forwarded | Rate limits key on the proxy, so all users share one bucket | Enable it in ARR; if it cannot be, set `TRUST_PROXY=false` |

Compression is optional: single-process mode does not gzip, so enable IIS dynamic
compression if you want JSON and HTML compressed.

---

## Verifying a deployment

Run through this once, from a browser on the network:

1. Open the site; the page loads over HTTPS with no console errors.
2. Upload a **large** source file — close to your upload cap. It should not 413.
3. Upload a target file, run the comparison, watch progress update.
4. Download the audit workbook; it should start immediately and complete.
5. `GET /api/readyz` shows `"status": "ready"` and sane memory numbers.
6. Check the logs show real client addresses in `ctx_client_ip`, not the proxy's.

## Troubleshooting

| Symptom                                    | Likely cause                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `413` / `404.13` on upload                 | Proxy body limit below `MAX_UPLOAD_BYTES` (nginx `client_max_body_size`, IIS `maxAllowedContentLength`)                                                          |
| Download hangs then arrives at once        | Response buffering on in the proxy                                                                                                                               |
| Download cut off part way                  | Proxy read/send timeout too short                                                                                                                                |
| "Run not found — it may have been evicted" | Result aged out of `MAX_CACHED_RUNS`, the service restarted, or it is being opened from a different browser (results are bound to the browser that created them) |
| "file not in cache — re-upload"            | The upload cache evicted it; raise memory or `MAX_CACHE_BYTES`                                                                                                   |
| `503 Server busy`                          | All comparison slots in use; raise `MAX_CONCURRENT_COMPARISONS` if the machine has the cores and RAM                                                             |
| Everyone shares one rate-limit bucket      | `TRUST_PROXY` does not match the number of proxies actually in front                                                                                             |
