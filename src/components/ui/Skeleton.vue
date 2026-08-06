<script setup lang="ts">
/**
 * The default loading state for a block of content.
 *
 * A centred spinner tells you nothing except that something is happening; it
 * also collapses the layout to a single dot and then snaps the real content in,
 * so every load reflows the page. A placeholder in the shape of what is coming
 * holds the space and lets the eye settle where the content will be. Prefer
 * this over `<Spinner centered />` for anything that occupies a region.
 *
 * `Spinner` is still right in two places, and only two: inside a `BaseButton`,
 * where the control keeps its own size and a placeholder would be nonsense, and
 * inline in a one-line status ("verifying…"), where there is no shape to hold.
 *
 * Pick the `variant` that matches what will replace it — a `cards` placeholder
 * followed by a table is worse than no placeholder, because it promises the
 * wrong layout. For a shape none of these cover, compose the bare `.skeleton`
 * class directly (see `LiveNetwork.vue`).
 */
withDefaults(
  defineProps<{
    /**
     * `text` — stacked lines, for prose and detail panels.
     * `cards` — a responsive grid of card tiles.
     * `stats` — a row of stat tiles (label over figure).
     * `table` — a header rule plus full-width rows.
     */
    variant?: "text" | "cards" | "stats" | "table";
    /** Lines / tiles / rows to draw. */
    count?: number;
    /** Prepend a title + description block, for a page that opens on a PageHeader. */
    header?: boolean;
    /** Announced to screen readers in place of the default "Loading". */
    label?: string;
  }>(),
  { variant: "text", count: 3, header: false },
);
</script>

<template>
  <!-- One live region for the whole block: the bars are decoration, so they
       are hidden and only this element speaks. `aria-busy` is what tells an
       assistive technology this is a placeholder rather than empty content. -->
  <div
    role="status"
    aria-busy="true"
    :aria-label="label || 'Loading'"
    class="w-full"
  >
    <!-- Matches PageHeader's title + description, so the page's top edge stops
         moving as soon as the placeholder paints. -->
    <div v-if="header" aria-hidden="true" class="mb-6 space-y-3">
      <div class="skeleton h-8 w-64 max-w-full"></div>
      <div class="skeleton h-4 w-96 max-w-full"></div>
    </div>

    <div v-if="variant === 'text'" aria-hidden="true" class="space-y-3 py-2">
      <!-- The last line is short. Uniform full-width bars read as a table;
           the ragged edge is what makes a block read as prose. -->
      <div
        v-for="i in count"
        :key="i"
        class="skeleton h-4"
        :class="i === count ? 'w-3/5' : 'w-full'"
      ></div>
    </div>

    <div
      v-else-if="variant === 'cards'"
      aria-hidden="true"
      class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"
    >
      <div v-for="i in count" :key="i" class="card space-y-3 p-6">
        <div class="skeleton h-10 w-10 rounded-control"></div>
        <div class="skeleton h-4 w-2/3"></div>
        <div class="skeleton h-3 w-full"></div>
        <div class="skeleton h-3 w-4/5"></div>
      </div>
    </div>

    <!-- Two-up on a phone, matching the real stat tiles — one per row would
         push the rest of the page below the fold while it loads. -->
    <div
      v-else-if="variant === 'stats'"
      aria-hidden="true"
      class="grid grid-cols-2 gap-4 sm:grid-cols-4"
    >
      <div v-for="i in count" :key="i" class="card space-y-3 p-5">
        <div class="skeleton h-3 w-20"></div>
        <div class="skeleton h-7 w-14"></div>
      </div>
    </div>

    <div v-else aria-hidden="true" class="space-y-3">
      <div class="skeleton h-9 w-full"></div>
      <div v-for="i in count" :key="i" class="skeleton h-11 w-full"></div>
    </div>
  </div>
</template>
