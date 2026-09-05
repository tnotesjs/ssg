<template>
  <div class="tn-site">
    <header class="tn-site-header">
      <a class="tn-site-brand" :href="site.base">{{ site.title }}</a>
      <div class="tn-site-actions">
        <button type="button" aria-label="搜索" @click="searchOpen = true">
          ⌕
        </button>
        <button type="button" aria-label="切换主题" @click="toggleTheme">
          ◐
        </button>
      </div>
    </header>

    <div class="tn-site-body">
      <aside class="tn-site-sidebar">
        <SidebarTree :items="site.sidebar" :route="route" :base="site.base" />
      </aside>
      <main class="tn-site-main">
        <component :is="page" />
      </main>
      <aside v-if="data.headings.length" class="tn-site-outline">
        <strong>本页目录</strong>
        <ul>
          <li v-for="heading in data.headings" :key="heading">{{ heading }}</li>
        </ul>
      </aside>
    </div>

    <div
      v-if="searchOpen"
      class="tn-search-mask"
      @click.self="searchOpen = false"
    >
      <section class="tn-search-dialog" role="dialog" aria-modal="true">
        <input
          ref="searchInput"
          v-model="query"
          autofocus
          placeholder="搜索标题和正文"
          @keydown.escape="searchOpen = false"
        />
        <p v-if="searching">正在载入索引…</p>
        <ul v-else>
          <li v-for="result in results" :key="result.route">
            <a :href="navHref(result.route)">
              <strong>{{ result.title }}</strong>
              <small>{{ result.text.slice(0, 120) }}</small>
            </a>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import MiniSearch from "minisearch";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import site from "virtual:tnotes-site";

import SidebarTree from "./components/SidebarTree.vue";
import { normalizeSearchTerm, tokenizeSearch } from "./search";
import type { PageData } from "../types";

const props = defineProps<{
  page: object;
  route: string;
  data: PageData;
}>();

type SearchResult = Pick<PageData, "route" | "title" | "text">;

const searchOpen = ref(false);
const searching = ref(false);
const query = ref("");
const searchInput = ref<HTMLInputElement>();
const index = ref<MiniSearch<SearchResult>>();
const results = computed<SearchResult[]>(() => {
  if (!query.value.trim() || !index.value) return [];
  return index.value
    .search(query.value, { prefix: true, fuzzy: 0.2 })
    .slice(0, 20)
    .map((result) => result as unknown as SearchResult);
});

const navHref = (link: string) => {
  if (/^(https?:)?\/\//.test(link)) return link;
  return `${site.base}${link.replace(/^\//, "")}`;
};

const toggleTheme = () => {
  const root = document.documentElement;
  const next = root.classList.contains("dark") ? "light" : "dark";
  root.classList.toggle("dark", next === "dark");
  localStorage.setItem("tnotes-theme", next);
};

watch(searchOpen, async (open) => {
  if (!open) return;
  await nextTick();
  searchInput.value?.focus();
  if (index.value) return;
  searching.value = true;
  try {
    const serialized = await fetch(`${site.base}search-index.json`).then(
      (response) => response.text(),
    );
    index.value = MiniSearch.loadJSON<SearchResult>(serialized, {
      fields: ["title", "headings", "text"],
      storeFields: ["route", "title", "text"],
      tokenize: tokenizeSearch,
      processTerm: normalizeSearchTerm,
      searchOptions: { boost: { title: 10, headings: 5, text: 3 } },
    });
  } finally {
    searching.value = false;
  }
});

onMounted(() => {
  const theme = localStorage.getItem("tnotes-theme");
  if (theme)
    document.documentElement.classList.toggle("dark", theme === "dark");
});
</script>
