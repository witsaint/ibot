/**
 * Joint regions for the supplied runningman.svg (628 × 837).
 * The source is a flattened tracing, so clips retain its original linework while
 * nested groups rotate around shoulders, elbows, hips and knees. Overlap at the
 * joints keeps the cut edges together. IDs are scoped to each WalkingBot instance.
 */
export function composeRunningBodySvg(id: string): string {
  const clips: Record<string, string> = {
    torso:
      "269,36 337,36 345,66 365,78 380,128 389,190 392,310 398,371 395,404 218,404 214,353 212,260 221,208 240,196 252,165 252,122 235,76",
    leftUpperArm:
      "230,75 244,94 253,127 252,160 241,192 223,205 207,258 211,281 155,285 152,257 164,193 178,135 196,95",
    leftForearm:
      "153,267 208,267 212,355 218,391 231,422 239,451 229,486 190,487 164,460 165,411 169,397 158,326",
    rightUpperArm: "361,75 391,91 409,127 419,194 426,267 388,273 387,198 379,143",
    rightForearm: "387,257 426,257 432,352 446,402 449,442 434,468 408,478 394,468 390,369",
    hips: "216,366 397,366 398,472 315,491 213,472",
    leftThigh: "216,436 321,436 319,484 306,579 300,606 211,606 216,558",
    leftCalf: "212,588 305,588 299,741 319,765 351,790 357,832 196,837 199,737",
    rightThigh: "321,436 398,436 400,604 314,604 312,491",
    rightCalf: "314,588 401,588 406,747 449,770 480,791 483,817 435,833 346,815 319,784",
  };
  const part = (name: string, children = "") =>
    `<g data-part="${name}"><g clip-path="url(#${id}-${name})"><use href="#${id}-art"/></g>${children}</g>`;
  return (
    `<g transform="translate(-38 460) scale(1.4)">` +
    `<defs><g id="${id}-art">` +
    // Opaque paper behind the transparent linework prevents the rear limbs showing through.
    `<path fill="var(--surface)" d="M270 36H337L345 66 387 89 410 126 428 287 433 367 446 412 442 448 431 464 399 467 400 601 406 747 455 775 477 796 475 810 453 819 399 815 350 805 351 821 330 831 287 831 243 818 215 805 212 778 214 605 219 482 199 480 177 467 169 445 172 397 156 289 156 252 169 180 184 124 199 96 231 76 257 65Z"/>` +
    `<image href="/illustrations/runningman.svg" width="628" height="837"/>` +
    `</g>` +
    Object.entries(clips)
      .map(
        ([name, points]) => `<clipPath id="${id}-${name}"><polygon points="${points}"/></clipPath>`,
      )
      .join("") +
    `</defs>` +
    part("rightUpperArm", part("rightForearm")) +
    part("rightThigh", part("rightCalf")) +
    part("leftThigh", part("leftCalf")) +
    part("hips") +
    part("torso") +
    part("leftUpperArm", part("leftForearm")) +
    `</g>`
  );
}
