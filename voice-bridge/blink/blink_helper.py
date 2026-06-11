#!/usr/bin/env python3
"""Blink doorbell helper for Project Atlas — wraps the (unofficial) blinkpy library.

Commands:
  auth                      one-time login. Reads BLINK_EMAIL / BLINK_PASSWORD env, prompts for the
                            2FA code, and saves a credential token to BLINK_CREDS.
  cameras                   print the list of camera names as JSON.
  snapshot "<cam>" <path>   snap a fresh still from <cam> and save it to <path>; prints <path>.
  poll "<cam>"              print JSON status for <cam> (motion flag + last-record timestamp) so the
                            Node side can detect a NEW doorbell/motion event by change.

Credentials are stored in BLINK_CREDS (default: ./.blink-creds.json next to this file).
The Node bridge shells out to this script; it never stores your Blink password (only the token).
"""
import asyncio
import getpass
import json
import os
import sys

from aiohttp import ClientSession
from blinkpy.blinkpy import Blink
from blinkpy.auth import Auth, BlinkTwoFARequiredError
from blinkpy.helpers.util import json_load

CREDS = os.environ.get("BLINK_CREDS", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".blink-creds.json"))


def patch_blinkpy():
    """Adapt blinkpy 0.25.5 to Blink's current OAuth: 2FA-required now returns HTTP 202 (was 412)."""
    from blinkpy import api

    _hdr = {
        "User-Agent": api.OAUTH_USER_AGENT,
        "Accept": "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://api.oauth.blink.com",
        "Referer": api.OAUTH_SIGNIN_URL,
    }

    async def oauth_signin(auth, email, password, csrf_token):
        resp = await auth.session.post(
            api.OAUTH_SIGNIN_URL, headers=_hdr,
            data={"username": email, "password": password, "csrf-token": csrf_token},
            allow_redirects=False,
        )
        if resp.status in (202, 412):
            return "2FA_REQUIRED"
        if resp.status in (301, 302, 303, 307, 308):
            return "SUCCESS"
        print(f"[patch] unexpected sign-in status {resp.status}", file=sys.stderr)
        return None

    async def oauth_verify_2fa(auth, csrf_token, twofa_code):
        resp = await auth.session.post(
            api.OAUTH_2FA_VERIFY_URL, headers=_hdr,
            data={"2fa_code": twofa_code, "csrf-token": csrf_token, "remember_me": "false"},
        )
        body = await resp.text()
        print(f"[patch] 2fa-verify HTTP {resp.status} body[:400]={body[:400]!r}", file=sys.stderr)
        return 200 <= resp.status < 300

    api.oauth_signin = oauth_signin
    api.oauth_verify_2fa = oauth_verify_2fa


async def connect(session):
    blink = Blink(session=session)
    blink.auth = Auth(await json_load(CREDS), no_prompt=True, session=session)
    await blink.start()
    await blink.refresh()
    return blink


async def cmd_auth(session):
    # Prompt (hidden password) unless provided via env — avoids shell-quoting issues with passwords.
    email = os.environ.get("BLINK_EMAIL") or input("Blink email: ").strip()
    password = os.environ.get("BLINK_PASSWORD") or getpass.getpass("Blink password: ")
    blink = Blink(session=session)
    blink.auth = Auth({"username": email, "password": password}, session=session)
    try:
        await blink.start()
    except BlinkTwoFARequiredError:
        code = input("Enter the Blink 2FA code (sent to your email/SMS): ").strip()
        if not await blink.send_2fa_code(code):  # completes OAuth 2FA + finishes setup itself
            sys.exit("2FA failed — re-run `auth` and enter a FRESH code quickly (codes expire fast).")
    if not getattr(blink, "available", False):
        sys.exit(
            "Login did not complete. If you just made several attempts, Blink may be rate-limiting — "
            "wait ~60 seconds, then run `auth` once more."
        )
    await blink.save(CREDS)
    print(f"OK — saved Blink credentials to {CREDS}")


async def cmd_diag(session):
    """Diagnostic: run the OAuth sign-in and print the raw status/body, to see why 2FA isn't detected."""
    from blinkpy import api

    email = os.environ.get("BLINK_EMAIL") or input("Blink email: ").strip()
    password = os.environ.get("BLINK_PASSWORD") or getpass.getpass("Blink password: ")
    blink = Blink(session=session)
    blink.auth = Auth({"username": email, "password": password}, session=session)

    orig = api.oauth_signin

    async def logged(auth, e, p, csrf):
        headers = {
            "User-Agent": api.OAUTH_USER_AGENT,
            "Accept": "*/*",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://api.oauth.blink.com",
            "Referer": api.OAUTH_SIGNIN_URL,
        }
        resp = await auth.session.post(
            api.OAUTH_SIGNIN_URL,
            headers=headers,
            data={"username": e, "password": p, "csrf-token": csrf},
            allow_redirects=False,
        )
        body = await resp.text()
        print(f"[diag] oauth_signin -> HTTP {resp.status}", file=sys.stderr)
        print(f"[diag] Location: {resp.headers.get('Location')}", file=sys.stderr)
        print(f"[diag] body[:600]: {body[:600]!r}", file=sys.stderr)
        if resp.status == 412:
            return "2FA_REQUIRED"
        if resp.status in (301, 302, 303, 307, 308):
            return "SUCCESS"
        return None

    api.oauth_signin = logged
    try:
        await blink.start()
        print(f"[diag] start() finished, available={getattr(blink, 'available', None)}", file=sys.stderr)
    except BlinkTwoFARequiredError:
        print("[diag] 2FA required was raised correctly (HTTP 412 path)", file=sys.stderr)
    except Exception as ex:  # noqa: BLE001
        print(f"[diag] {type(ex).__name__}: {ex}", file=sys.stderr)
    finally:
        api.oauth_signin = orig


async def cmd_cameras(session):
    blink = await connect(session)
    print(json.dumps(list(blink.cameras.keys())))


async def cmd_snapshot(session, cam, path):
    blink = await connect(session)
    if cam not in blink.cameras:
        sys.exit(f"No camera named {cam!r}. Available: {list(blink.cameras.keys())}")
    camera = blink.cameras[cam]
    await camera.snap_picture()
    await blink.refresh()
    await camera.image_to_file(path)
    print(path)


async def cmd_clip(session, cam, path):
    blink = await connect(session)
    if cam not in blink.cameras:
        sys.exit(f"No camera named {cam!r}. Available: {list(blink.cameras.keys())}")
    camera = blink.cameras[cam]
    # The recorded clip is uploaded to Blink's cloud a few seconds after the event — wait for it.
    for _ in range(4):
        await blink.refresh()
        if getattr(camera, "clip", None) or (camera.attributes.get("recent_clips") or []):
            break
        await asyncio.sleep(3)
    await camera.video_to_file(path)
    print(path)


async def cmd_poll(session, cam):
    import urllib.parse

    blink = await connect(session)
    if cam not in blink.cameras:
        sys.exit(f"No camera named {cam!r}. Available: {list(blink.cameras.keys())}")
    attrs = blink.cameras[cam].attributes or {}
    thumb = attrs.get("thumbnail") or ""
    thumb_ts = ""
    if "ts=" in thumb:
        thumb_ts = urllib.parse.parse_qs(urllib.parse.urlparse(thumb).query).get("ts", [""])[0]
    out = {
        "motion_detected": attrs.get("motion_detected"),
        "last_record": attrs.get("last_record"),
        "recent_clips": len(attrs.get("recent_clips") or []),
        "thumb_ts": thumb_ts,
    }
    print(json.dumps(out, default=str))


async def main():
    patch_blinkpy()  # adapt to Blink's current OAuth (2FA via HTTP 202)
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    async with ClientSession() as session:
        if cmd == "auth":
            await cmd_auth(session)
        elif cmd == "diag":
            await cmd_diag(session)
        elif cmd == "cameras":
            await cmd_cameras(session)
        elif cmd == "snapshot":
            await cmd_snapshot(session, sys.argv[2], sys.argv[3])
        elif cmd == "clip":
            await cmd_clip(session, sys.argv[2], sys.argv[3])
        elif cmd == "poll":
            await cmd_poll(session, sys.argv[2])
        else:
            sys.exit('usage: auth | cameras | snapshot "<cam>" <path> | poll "<cam>"')


if __name__ == "__main__":
    asyncio.run(main())
