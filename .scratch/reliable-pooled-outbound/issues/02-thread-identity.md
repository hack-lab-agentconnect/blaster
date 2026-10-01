# Thread identity under rotation

Type: grilling
Status: open
Blocked by:

## Question

A conversation is keyed on `(peer, blasterNumber)`, so a contact reached from
three pool numbers has three threads. `campaignFor` reunites them under one
campaign, but the inbox still shows one row per number, and the reply re-check now
scans every thread for the peer.

Decide what the canonical thread is: (a) keep the per-number threads and give the
inbox a grouped "one person" view, (b) key the thread on the peer with the
sending number as an attribute that changes over time, or (c) something else.
The answer decides whether a reply, an unread badge, and a STOP are counted once
or N times, and what `campaignFor` should match on.
