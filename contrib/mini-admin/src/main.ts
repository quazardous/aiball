import { createApp } from "vue";
import PrimeVue from "primevue/config";
import Aura from "@primeuix/themes/aura";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";

// STEP 2 REOPENED THIS FILE. Step 1 booted on `vue` alone and looked fine —
// but the kit's CSS reads `--p-*` custom properties (--p-content-background,
// --p-text-color, …) that nothing in this repo defines: they are injected at
// runtime by PrimeVue's Aura preset. Without it the kit renders shapeless, and
// nothing errors. The kit also ships no input/button, so any form reaches for
// PrimeVue's directly.
import "primeicons/primeicons.css";

// The kit's components ship no scoped styles — their `.aiball-*` classes are
// defined in the frontend's global stylesheet, so it is a hard dependency.
import "@frontend/style.css";

import App from "./App.vue";

const app = createApp(App);
app.use(PrimeVue, {
    theme: {
        preset: Aura,
        options: { darkModeSelector: ".aiball-dark" },
    },
});

// Registered globally so the demo's templates read like the frontend's panels.
app.component("Button", Button);
app.component("InputText", InputText);
app.component("Select", Select);

app.mount("#app");
