# Calculators

One file per calculator. Every `.json` file in this folder is loaded; the
file name is up to you, and files are read in name order, which is also
the order their line items appear on the deal.

To add a calculator:

```sh
npm run new-calculator -- <id> "<Name>"   # creates <id>.json to fill in
npm run check                             # validates it against HubSpot
npm run plan -- <test deal id>            # dry run on a real deal
```

then commit and deploy. See [Adding a calculator](../../README.md#adding-a-calculator)
and the examples in [`examples/calculators/`](../../examples/calculators/).
