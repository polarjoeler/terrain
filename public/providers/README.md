# Provider logos

Drop a logo here named after the provider's URL slug and the report at
`/p/<slug>` picks it up automatically — no code change.

    public/providers/stitch.png      ->  /p/stitch
    public/providers/peach-payments.svg  ->  /p/peach-payments

The slug is `providerSlug(<canonical gateway name>)` from `lib/provider-slug.ts`
(lowercase, non-alphanumerics collapsed to `-`). Extensions are tried in order:
`.svg`, `.png`, `.webp`. With no file present the page falls back to the
provider's name as text, which is the default for every gateway.

Use a transparent background. Logos render on a cream chip, so dark brand
colours keep their contrast — don't pre-recolour the artwork.
