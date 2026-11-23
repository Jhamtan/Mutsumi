<script setup lang="ts">
import { useI18nStore } from '@renderer/store/i18n'

const i18nStore = useI18nStore()
</script>

<template>
  <div class="app-page auth-page">
    <main class="auth-stage">
      <div class="app-surface auth-shell">
        <aside class="auth-intro">
          <button
            type="button"
            class="locale-button absolute right-4 top-4 z-2"
            :aria-label="i18nStore.t.common.switchLanguage"
            @click="i18nStore.toggleLocale()"
          >
            <span class="i-carbon-language text-base" aria-hidden="true"></span>
            {{ i18nStore.locale === 'zh' ? 'English' : '中文' }}
          </button>
          <div class="relative z-1">
            <p class="eyebrow">{{ i18nStore.t.auth.eyebrow }}</p>
            <h2 class="auth-intro-title">{{ i18nStore.t.auth.title }}</h2>
            <p class="auth-intro-description">{{ i18nStore.t.auth.description }}</p>
          </div>
          <div class="auth-landscape" aria-hidden="true">
            <div class="landscape-window">
              <div class="landscape-sun"></div>
              <div class="landscape-hill landscape-hill-back"></div>
              <div class="landscape-hill landscape-hill-front"></div>
              <div class="landscape-path"></div>
            </div>
            <span class="landscape-orbit landscape-orbit-one"></span>
            <span class="landscape-orbit landscape-orbit-two"></span>
          </div>
          <p class="auth-intro-note">
            <span class="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true"></span>
            {{ i18nStore.t.auth.note }}
          </p>
        </aside>
        <div class="auth-form-pane">
          <router-view v-slot="{ Component }">
            <transition name="form-switch" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.auth-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px 36px 18px;
  background:
    radial-gradient(ellipse at 0% 5%, #e1f5e9 0, transparent 52%),
    radial-gradient(ellipse at 100% 100%, #e1eefc 0, transparent 55%), #f5f9f8;
}

.auth-stage {
  display: flex;
  flex: 1 0 auto;
  align-items: center;
  justify-content: center;
}

.auth-shell {
  display: grid;
  grid-template-columns: 0.9fr 1.1fr;
  width: 100%;
  max-width: 920px;
  min-height: 460px;
  border-radius: 28px;
}

.auth-intro {
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 36px 32px 26px;
  border-radius: 27px 0 0 27px;
  background: linear-gradient(155deg, #e1f5e9 0%, #edf8f5 45%, #e1eefc 100%);
}

.auth-intro-title {
  margin-top: 18px;
  font-size: clamp(28px, 3.5vw, 38px);
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.04em;
  white-space: pre-line;
}

.auth-intro-description {
  --uno: text-ink-muted;
  max-width: 240px;
  margin-top: 14px;
  font-size: 13px;
  line-height: 1.9;
}

.auth-landscape {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 190px;
  margin: 16px 0;
}

.landscape-window {
  position: relative;
  width: 170px;
  height: 190px;
  overflow: hidden;
  border: 5px solid rgb(255 255 255 / 80%);
  border-radius: 90px 90px 24px 24px;
  background: linear-gradient(180deg, #c5ddf7, #f2f9ff);
  box-shadow: 0 14px 28px -16px rgb(45 98 158 / 35%);
  transform: rotate(-7deg);
}

.landscape-sun {
  position: absolute;
  top: 31px;
  right: 28px;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: #fffdf3;
  box-shadow: 0 0 0 10px rgb(255 255 255 / 20%);
}

.landscape-hill {
  position: absolute;
  width: 230px;
  height: 150px;
  border-radius: 50%;
}

.landscape-hill-back {
  right: -95px;
  bottom: -43px;
  background: #9cdabb;
  transform: rotate(-28deg);
}

.landscape-hill-front {
  bottom: -73px;
  left: -65px;
  background: #6dc29c;
  transform: rotate(24deg);
}

.landscape-path {
  position: absolute;
  bottom: -46px;
  left: 80px;
  width: 48px;
  height: 120px;
  border-radius: 50%;
  border-left: 15px solid #edf8f5;
  transform: rotate(34deg);
}

.landscape-orbit {
  position: absolute;
  border: 1px solid rgb(255 255 255 / 90%);
  background: rgb(255 255 255 / 50%);
  box-shadow: 0 8px 20px -12px rgb(45 98 158 / 25%);
}

.landscape-orbit-one {
  top: 22%;
  left: 8%;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  transform: rotate(-18deg);
}

.landscape-orbit-two {
  right: 8%;
  bottom: 14%;
  width: 20px;
  height: 20px;
  border-radius: 50%;
}

.auth-intro-note {
  --uno: text-brand-700;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  letter-spacing: 0.03em;
}

.auth-form-pane {
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 28px 36px;
}

@media (max-width: 720px) {
  .auth-page {
    padding: 20px;
  }

  .auth-shell {
    grid-template-columns: 1fr;
    max-width: 440px;
    min-height: 0;
  }

  .auth-intro {
    display: none;
  }

  .auth-form-pane {
    padding: 32px;
  }
}

@media (max-width: 380px) {
  .auth-page {
    padding: 16px 12px;
  }

  .auth-form-pane {
    padding: 28px 22px;
  }
}
</style>

<style>
.auth-card {
  width: 100%;
  min-width: 0;
}

.auth-card-heading {
  margin-bottom: 26px;
}

.auth-card-icon {
  --uno: text-accent-700 bg-accent-50;
  display: inline-flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
  border: 1px solid #e1eefc;
  border-radius: 14px;
  font-size: 20px;
}

.auth-card-title {
  --uno: text-ink;
  font-size: 26px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.035em;
}

.auth-card-subtitle {
  --uno: text-ink-muted;
  margin-top: 9px;
  font-size: 13px;
  line-height: 1.7;
}

.custom-form {
  --el-color-primary: #3974b6;
  --el-color-danger: #bf4d59;
  --el-text-color-regular: #233e46;
  --el-text-color-placeholder: #72858d;
  --el-border-color: #dce7e9;
  --el-border-color-hover: #a2c6ed;
  --el-fill-color-blank: #fbfdfd;
  --el-border-radius-base: 12px;
}

.custom-form .el-form-item {
  margin-bottom: 21px;
}

.custom-form .el-form-item__label {
  --uno: text-ink;
  margin-bottom: 7px;
  padding: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}

.custom-form .el-input__wrapper {
  min-height: 44px;
  padding: 0 14px;
  transition:
    box-shadow 180ms ease,
    background-color 180ms ease;
}

.custom-form .el-input__wrapper.is-focus {
  background: #fff;
  box-shadow:
    0 0 0 1px var(--el-color-primary) inset,
    0 0 0 3px rgb(83 139 203 / 12%);
}

.custom-form .el-form-item.is-error .el-input__wrapper {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

.custom-form .el-form-item__error {
  padding-top: 4px;
  font-size: 11px;
}

.auth-actions {
  margin-top: 26px;
}

.auth-switch {
  --uno: text-ink-muted;
  margin-top: 20px;
  text-align: center;
  font-size: 12px;
}

.auth-card-register .auth-card-heading {
  margin-bottom: 14px;
}

.auth-card-register .el-form-item {
  margin-bottom: 12px;
}

.auth-card-register .auth-actions {
  margin-top: 18px;
}

.form-switch-enter-active,
.form-switch-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}

.form-switch-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.form-switch-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
</style>
