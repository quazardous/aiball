import { createApp } from "vue";

// The kit's components ship no scoped styles — their `.aiball-*` classes are
// defined in the frontend's global stylesheet, so it is a hard dependency.
import "@frontend/style.css";

import App from "./App.vue";

createApp(App).mount("#app");
