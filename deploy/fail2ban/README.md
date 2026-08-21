# fail2ban setup

The app writes one line per sign-in attempt to a plain text file, and fail2ban
turns repeated failures into a firewall ban. This directory holds the two files
fail2ban needs.

## Why this exists

The login route already throttles failures in memory, but that layer cannot be the
only one:

- It lives in the process, so a restart clears it.
- It only reacts *after* Node has accepted the connection, parsed the body, and run
  scrypt on the candidate password.
- A single password with no user list is the exact shape brute force likes.

fail2ban drops the source at the firewall instead, before the request reaches the
app at all, and the ban survives a restart.

## Install

**1. Point the app at a log file.** In `.env.local`:

```bash
AUTH_LOG_PATH=/srv/funding-rate-market/data/auth.log
```

Unset, nothing is logged and fail2ban has nothing to read. Use an absolute path —
fail2ban runs as root and does not know the app's working directory.

**2. If the app sits behind a reverse proxy, say so.** Also in `.env.local`:

```bash
TRUST_PROXY_HOPS=1
```

> **Without this, fail2ban cannot ban anyone.** Next.js route handlers do not expose
> the raw socket address — `NextRequest` carries cookies and the URL, and nothing
> else — so the client address can only come from a forwarding header. With
> `TRUST_PROXY_HOPS` unset every line records `direct`, which the filter deliberately
> does not match. The jail will load, the log will fill, and no ban will ever fire.
>
> So either put a reverse proxy in front and set this to `1`, or ban on the proxy's
> own access log instead. Do not install the jail and assume it is working.

This is the number of proxies in front of the app, and it matters more than it looks.
`x-forwarded-for` is a header a client can send, so trusting it blindly hands an
attacker two things: a way to evade their own ban by rotating a fake value, and a way
to get **an arbitrary third party banned** by claiming to be them.

- Unset or `0` — no forwarding header is trusted. Every line records `direct`; see
  the warning above.
- `1` — one reverse proxy, the usual nginx or Caddy setup.
- `2` — two trusted hops, e.g. Cloudflare in front of nginx.

Set it to the real number. Too high and the address is read from a position the
client controls; too low and a legitimate proxy hop gets banned instead of the
client.

**3. Copy the two config files.**

```bash
sudo cp deploy/fail2ban/filter.d/funding-rate-market.conf /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/jail.d/funding-rate-market.conf   /etc/fail2ban/jail.d/
```

**4. Edit `logpath` and `port` in the jail** to match your deployment. The shipped
values assume `/srv/funding-rate-market/data/auth.log` and port 3000. Behind nginx
on 443, `port` should be `http,https` — banning 3000 achieves nothing when nothing
reaches 3000 directly.

**5. Reload and check.**

```bash
sudo fail2ban-client reload
sudo fail2ban-client status funding-rate-market
```

## Verify before trusting it

Test the filter against real lines rather than assuming it matches:

```bash
sudo fail2ban-regex /srv/funding-rate-market/data/auth.log \
  /etc/fail2ban/filter.d/funding-rate-market.conf
```

Expect the failed-password lines to match and the accepted ones to be ignored. If
`Missed lines` is non-zero for a line that *should* count, the filter is wrong and
the jail is decoration.

Then make one deliberate mistake at the login page and confirm it appears:

```bash
tail -f /srv/funding-rate-market/data/auth.log
```

## Log format

```
2026-08-21T09:14:03.114Z auth: failed password for frs from 203.0.113.9
2026-08-21T09:14:07.902Z auth: rate-limited attempt for frs from 203.0.113.9
2026-08-21T09:15:11.440Z auth: accepted password for frs from 203.0.113.9
```

Only `failed password` counts towards a ban. `rate-limited attempt` means the app's
own throttle already refused the request, so counting it would punish one burst
twice; it is logged separately so you can decide otherwise. Successes are logged
because after a ban fires, "did anyone actually get in" is the question that matters,
and a file with only failures cannot answer it.

Nothing in a line is attacker-controlled. The address is validated before being
written, and anything that is not a bare IP becomes the literal `unknown` — which the
filter does not match, so a malformed address cannot ban anybody. That is the property
worth checking if you edit the filter: a line like

```
… auth: failed password for frs from 1.2.3.4\n… from 8.8.8.8
```

must be impossible, because otherwise an attacker can write their own ban entries and
have a third party blocked. The password is never logged either, not even its length.

## Rotation

The app appends and never rotates. Each attempt is a few dozen bytes, so this is
slow, but a scanner is not polite. Add `/etc/logrotate.d/funding-rate-market`:

```
/srv/funding-rate-market/data/auth.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    create 0640 funding-rate funding-rate
}
```

fail2ban follows the file across a rotation on its own; no reload is needed.

## What this does not cover

fail2ban protects the password. It does nothing about the two arms — `AUTO_TRADING`
and `REBALANCE_AUTOMATION` — which is deliberate: those are unset by default and
turning them on requires editing the environment on the host, so they are not
reachable by anyone who has not already got in.

Worth doing alongside, none of which this directory handles:

- Put the app behind a reverse proxy with TLS. The session cookie is only marked
  `secure` when the request arrives over HTTPS, so on plain HTTP it can be read off
  the wire.
- Do not expose port 3000 to the internet once a proxy is in front of it.
- Enable a jail for `sshd` as well. An attacker with shell access does not need the
  app's password at all — `.env.local` is right there.
