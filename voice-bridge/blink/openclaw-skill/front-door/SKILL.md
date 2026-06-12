---
name: front-door
description: "Show the front door / who is at the door. Use whenever the user asks to see the front door, check the doorbell camera, or whether anyone or anything is at the door (e.g. 'show me the front door', 'who's at the door', 'is there anyone outside?', 'anything at the door?')."
metadata:
  {
    "openclaw":
      {
        "emoji": "🚪",
      },
  }
---

# Front door

The user has a Blink doorbell wired into their local "Jarvis" setup. To show them the front door,
run this script — it snaps the doorbell camera and sends the photo straight to the user's chat:

    bash /Users/lukasmac/Documents/project-atlas/voice-bridge/blink/door-to-telegram.sh

Then reply with one short line, e.g. "Here's your front door 👇". The script sends the photo itself,
so you don't need to attach anything — just run it and give a brief acknowledgement.

If the script errors (the Blink token can expire), tell the user to re-run
`blink_helper.py auth` in voice-bridge/blink.
