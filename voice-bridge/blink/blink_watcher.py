#!/usr/bin/env python3
"""Long-lived Blink doorbell watcher.

Connects ONCE and stays connected (so the token is kept alive in place instead of re-authenticating
every poll — which is what was tripping the 2FA re-login). Polls only the doorbell and prints a JSON
line to stdout on each new event. An event = a change in the recorded-clip timestamp (motion) OR the
thumbnail timestamp (a button press grabs a fresh thumbnail even without recording a clip). On an
event it snaps a still (and the clip, if requested) on this same authenticated connection and reports
the file paths, so the Node side never opens a second Blink connection.

  usage: blink_watcher.py "<camera>" <media_dir> <photo|video>
"""
import asyncio
import json
import logging
import os
import sys
import urllib.parse

from aiohttp import ClientSession
from blinkpy.blinkpy import Blink
from blinkpy.auth import Auth
from blinkpy.helpers.util import json_load

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from blink_helper import patch_blinkpy, CREDS  # noqa: E402  (reuse the OAuth-202 patch + creds path)

logging.getLogger("blinkpy").setLevel(logging.CRITICAL)  # silence noise (e.g. the off outside camera)

CAMERA = sys.argv[1]
MEDIA_DIR = sys.argv[2]
WANT_CLIP = len(sys.argv) > 3 and sys.argv[3] == "video"
INTERVAL = max(5, int(os.environ.get("BLINK_POLL_SECONDS", "15")))
IMAGE = os.path.join(MEDIA_DIR, "door.jpg")
CLIP = os.path.join(MEDIA_DIR, "door.mp4")


def emit(obj):
    print(json.dumps(obj), flush=True)


def thumb_ts(attrs):
    t = attrs.get("thumbnail") or ""
    if "ts=" in t:
        return urllib.parse.parse_qs(urllib.parse.urlparse(t).query).get("ts", [""])[0]
    return ""


def key_of(attrs):
    # last_record/recent_clips catch motion; thumb_ts also catches a button press (fresh thumbnail).
    return f"{attrs.get('last_record')}|{len(attrs.get('recent_clips') or [])}|{thumb_ts(attrs)}"


async def capture(blink, cam):
    """Snap a FRESH still (and clip if wanted) on the live connection. Returns (image, clip).

    A battery doorbell takes several seconds to actually capture + upload a new image. image_to_file
    downloads whatever the current thumbnail URL points at, so if we read too soon we'd save the LAST
    real capture (yesterday's). So: request a new image, then wait until the thumbnail timestamp
    advances (new image is ready) before saving — up to ~14s.
    """
    img = None
    clip = None
    try:
        before = thumb_ts(cam.attributes or {})
        await cam.snap_picture()  # ask the camera for a fresh image
        for _ in range(7):
            await asyncio.sleep(2)
            try:
                await blink.refresh(force=True)
            except Exception:  # noqa: BLE001
                pass
            if thumb_ts(cam.attributes or {}) != before:
                break  # the fresh image has uploaded
        await cam.image_to_file(IMAGE)
        img = IMAGE
    except Exception as e:  # noqa: BLE001
        emit({"warn": f"snapshot failed: {e}"})
    if WANT_CLIP:
        try:
            await cam.video_to_file(CLIP)
            clip = CLIP
        except Exception:  # noqa: BLE001
            clip = None  # press events often have no clip — Node falls back to the photo
    return img, clip


async def main():
    patch_blinkpy()
    os.makedirs(MEDIA_DIR, exist_ok=True)
    async with ClientSession() as session:
        blink = Blink(session=session)
        blink.auth = Auth(await json_load(CREDS), no_prompt=True, session=session)
        try:
            await blink.start()
        except Exception as e:  # noqa: BLE001
            emit({"fatal": f"connect failed ({type(e).__name__}); re-run `blink_helper.py auth`"})
            return
        cam = blink.cameras.get(CAMERA)
        if not cam:
            emit({"fatal": f"camera {CAMERA!r} not found; have {list(blink.cameras)}"})
            return
        emit({"ready": True, "camera": CAMERA, "interval": INTERVAL})

        baseline = key_of(cam.attributes or {})
        errors = 0
        while True:
            await asyncio.sleep(INTERVAL)
            try:
                await blink.refresh(force=True)
                errors = 0
            except Exception as e:  # noqa: BLE001
                errors += 1
                try:
                    await blink.auth.refresh_tokens()  # renew access token without a 2FA re-login
                except Exception:  # noqa: BLE001
                    pass
                if errors in (1, 20):
                    emit({"warn": f"refresh failed ({type(e).__name__}); retrying. Re-run `auth` if it persists."})
                continue

            attrs = cam.attributes or {}
            if key_of(attrs) == baseline:
                continue

            img, clip = await capture(blink, cam)
            # Our own snapshot bumped the thumbnail ts — re-baseline AFTER capturing so we don't loop.
            await blink.refresh(force=True)
            baseline = key_of(cam.attributes or {})
            emit({"event": True, "image": img, "clip": clip, "last_record": str(attrs.get("last_record"))})


if __name__ == "__main__":
    asyncio.run(main())
