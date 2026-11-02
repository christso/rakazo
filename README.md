# Multi-account dogfooding evidence

Review captures for [the multi-account implementation](https://github.com/elie222/rakazo/pull/3123).
This branch has independent history and targets an empty orphan base. The draft
can be closed after review without merging evidence into the application.

These screenshots show the browser journey at feature revision `aabeb1f1f69d81d4055ac776a92fd0a37f65f323`,
which combines upstream `149fdd606`, the maintainer's published cleanup through
`c3e00c0d0`, and the account picker. They use fictional accounts against an
isolated API. No production services or private account data were used.

## Account menu

The current identity stays visible. The account list and Add account action open
only after selecting “Switch accounts”.

![Account menu](screenshots/account-menu.png)

## Desktop account picker

The picker retains account avatars, names, emails, unread counts and the selected
checkmark from the maintainer's layout.

![Desktop account picker](screenshots/switcher-desktop.png)

## Phone-width browser picker

![Phone-width browser picker](screenshots/switcher-phone.png)

This is a responsive browser capture, not a native mobile screenshot.

## Hidden-account unread count

Receiving another account's notification leaves the current account displayed.
Tapping verifies and selects the owning saved account before opening its chat.

![Hidden-account unread count](screenshots/unread.png)

## Sign out all confirmation

Cancelling preserves both saved logins. Confirming removes both sessions.

![Sign out all confirmation](screenshots/sign-out-all.png)

## Verification

The real browser journey passed for adding and switching accounts, unread counts,
hidden-account notification routing, tab refresh, stale-request rejection and
independent/all-account sign-out. Focused unit tests, three PostgreSQL suites,
workspace typechecks, lint and the web production build also passed.

Physical-device push delivery, native compilation and the iOS screenshot flow
remain unverified. This evidence does not cover the maintainer's additional
unpublished rewrite; integrating that pass needs a published ref.

This draft contains no application code or workflow configuration. It is for
review and closure, not merge or deployment.
