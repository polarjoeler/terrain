// Client-safe Japan region constants — no DB/postgres import, so this can be pulled into client
// components (the replay map) without dragging server-only modules into the browser bundle.
export const JP_REGIONS = ["Hokkaido", "Tohoku", "Kanto", "Chubu", "Kansai", "Chugoku", "Shikoku", "Kyushu"] as const;
export type JpRegion = (typeof JP_REGIONS)[number];
