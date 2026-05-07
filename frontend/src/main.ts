import { createApp } from "vue";
import PrimeVue from "primevue/config";
import Aura from "@primeuix/themes/aura";
import ToastService from "primevue/toastservice";
import ConfirmationService from "primevue/confirmationservice";

import "primeicons/primeicons.css";
import "./style.css";

import App from "./App.vue";

const app = createApp(App);
app.use(PrimeVue, {
    theme: {
        preset: Aura,
        options: { darkModeSelector: ".aiball-dark" },
    },
});
app.use(ToastService);
app.use(ConfirmationService);
app.mount("#app");
