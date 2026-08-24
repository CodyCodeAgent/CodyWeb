import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './style.css'
import '@codycodeagent/cody-web-core/vue/style.css'

createApp(App).use(router).mount('#app')
