# Woolworths checkout approval at 67% browser zoom

The recording uses a genuine Woolworths checkout in a maximized Chromium window on a Linux Docker desktop. The crop shows only the **Edit** control. The captions report the result returned by each helper.

| Helper | Visible target | Preflight result |
|---|---|---|
| Upstream `96b210e4a73047324603edbf6f59359f2a70e0bf` | Edit | Asked for approval for **Place order** |
| Fork `546fcb840dcf14c32b838639f971a2722f2bbd3b` | Same point on Edit | No payment approval |

The comparison ran the two desktop purchase checks in separate Chromium isolated worlds on the same page. Neither check sent mouse input. No items were added, no delivery slot was reserved, and no order or payment was submitted for this test.

[Video](woolworths-checkout-red.mp4) · [Fork fix](https://github.com/christso/rakazo/pull/12)
