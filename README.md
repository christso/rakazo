# Checkout scroll approval evidence

Evidence for [elie222/rakazo#4728](https://github.com/elie222/rakazo/issues/4728).
The fix is [christso/rakazo#4](https://github.com/christso/rakazo/pull/4),
commit `9658140f1d6422ca9b2292a113541695f3586ba7`.

## Live Woolworths symptom

[Live checkout recording (MP4, 49 seconds)](live-woolworths-note.mp4).

The requested action is Add shopper note. The recorded native approval instead
names Pay using Gift Card and is denied. That card screenshot is held beside a
later read-only capture of the same failure. The scroll frames play ten times
slower with measured timestamps; the replay executes no note or payment click.
The already-visible comparison uses the same unfixed code. This clip documents
the symptom rather than the deployed fix.

Product rows, quantities, prices, totals and delivery details are covered in the
public export. The source recording is retained privately. The visible native
card label and shopper-note control are original application/merchant pixels;
privacy masks and explanatory captions do not replace an outcome.

## Synthetic reproduction and fix

[Before/after recording (MP4, 57 seconds)](synthetic-before-after.mp4).

Both cases use the same synthetic checkout with four separate offscreen notes.
Baseline `4982abbf98ac95cc4b5d4ab1edd8515c15c187e6` still produces a false approval
on a later note. The fixed helper, SHA-256
`8e264b64173575c967468e015791667f76e9f788c652ad0dad792059515b17d0`,
opens each of the four editors once and keeps final Place order approval.

The API, Pi runtime, page helper and approval UI are actual Rakazo components.
Model tool choices are scripted; computer provisioning/storage use test adapters.
Products, shopper details, address and delivery information in this clip are
fictional. No Allow is pressed, no note is saved, and simulated submissions stay
at zero. Capture-only styling hides prior run messages; captions disclose scope.
The film was captured before deployment; its local-comparison captions retain
that historical scope.

## Live fix verification

A separate read-only comparison on the same live Woolworths checkout returned
three false Gift Card classifications with the baseline helper and none in three
checks with the deployed fixed helper. These checks executed no note or payment
clicks. Real payment submission was not tested.
