# Multi-account dogfooding evidence

This branch contains review-only evidence for the multi-account implementation at
`ad5ac51ff6d1e107bd80bc0db0ff2b63ac966951`. It has independent history and targets an empty orphan base so this
review can be closed without merging evidence into the application.

These are browser dogfooding captures from the actual two-account journey against
an isolated local API with fictional accounts. They are not captures from a live
deployment. No private account data, credentials or production services were used.

The journey adds and switches saved accounts without another credential prompt,
checks each account's unread count, receives a hidden account's notification and
opens the correct account/chat, follows an account change in another tab, rejects
a stale-account request, and signs out one or all accounts. It passed.

## Desktop switcher

![Desktop account switcher](screenshots/switcher-desktop.png)

## Phone-width browser switcher

![Phone-width account switcher](screenshots/switcher-phone.png)

This is a responsive browser capture, not an iOS or Android device screenshot.

## Hidden-account unread count

![Hidden account unread count](screenshots/unread.png)

## Verification limits

Focused offline tests, Postgres tests, the browser journey, type checks, lint and
the web production build passed. Three unrelated full-suite shell/backup failures
were reproduced on pristine starting-revision source.

Physical-device push permissions/delivery, native Kotlin compilation and native
simulator screenshots remain unverified. The implementation adds a native
screenshot-catalog flow, but that flow was not run.

This draft contains no application code or workflow configuration. It is intended
for review and closure, not merge or deployment.

## Sign out all confirmation

The follow-up browser journey verifies that cancelling preserves both saved logins,
then confirming removes both sessions. This screenshot shows the shared confirmation
dialog from the feature follow-up in [the implementation PR](https://github.com/elie222/rakazo/pull/3123).

![Sign out all confirmation](screenshots/sign-out-all.png)
