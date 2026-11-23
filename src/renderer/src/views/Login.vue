<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus'
import type { LoginOptionsDTO, RememberedAccountInfoDTO } from '@common/types'
import { useI18nStore } from '@renderer/store/i18n'
import { useUserStore } from '@renderer/store/user'
import { getSafeLoginRedirect } from '@renderer/composables/useSessionOperation'

const router = useRouter()
const route = useRoute()
const i18nStore = useI18nStore()
const userStore = useUserStore()
const formRef = ref<FormInstance>()
const loading = ref(false)
const forgetting = ref(false)
const preferRememberedPassword = ref(false)
const rememberChoiceChanged = ref(false)
const remembered = ref<RememberedAccountInfoDTO>({
  email: '',
  hasSavedPassword: false,
  encryptionAvailable: false,
  recordStatus: 'unavailable'
})
let mounted = true
let ownedAttempt: number | undefined

const formData = reactive({ email: '', password: '', rememberAccount: false })
const canUseRemembered = computed(
  () => remembered.value.hasSavedPassword && formData.email === remembered.value.email
)
const usingRememberedPassword = computed(
  () => canUseRemembered.value && preferRememberedPassword.value && formData.password.length === 0
)
const rules = computed<FormRules>(() => ({
  email: [
    { required: true, message: i18nStore.t.login.emailReq, trigger: 'blur' },
    { type: 'email', message: i18nStore.t.login.emailInvalid, trigger: 'blur' }
  ],
  password: [
    {
      required: !usingRememberedPassword.value,
      message: i18nStore.t.login.passReq,
      trigger: 'blur'
    }
  ]
}))
watch(
  () => formData.password,
  (value) => {
    if (value.length > 0) preferRememberedPassword.value = false
  }
)
watch(
  () => formData.email,
  (value) => {
    if (value !== remembered.value.email) preferRememberedPassword.value = false
  }
)

async function loadRememberedAccount(): Promise<void> {
  const revision = userStore.sessionRevision
  if (typeof window.api?.getRememberedAccount !== 'function') return
  try {
    const response = await window.api.getRememberedAccount()
    if (
      !mounted ||
      loading.value ||
      revision !== userStore.sessionRevision ||
      rememberChoiceChanged.value
    )
      return
    if (!response.success || !response.data) return
    remembered.value = response.data
    formData.rememberAccount = response.data.hasSavedPassword
    if (!formData.email && !formData.password) formData.email = response.data.email
    if (canUseRemembered.value && !formData.password) preferRememberedPassword.value = true
  } catch {
    // Preferences do not authenticate the renderer and failures never clear a session.
  }
}

onMounted(async () => {
  await nextTick()
  if (!mounted) return
  const email = route.query.email
  if (typeof email === 'string' && email.length <= 254) formData.email = email
  await loadRememberedAccount()
})
onBeforeUnmount(() => {
  mounted = false
  if (ownedAttempt !== undefined && userStore.cancelAuthentication(ownedAttempt)) {
    // The current attempt is abandoned before another login can own the renderer.
    if (typeof window.api?.logout === 'function') void window.api.logout().catch(() => undefined)
  }
})

function useRememberedPassword(): void {
  if (!canUseRemembered.value || loading.value || forgetting.value) return
  formData.password = ''
  preferRememberedPassword.value = true
  formRef.value?.clearValidate?.('password')
}

async function forgetRememberedAccount(): Promise<void> {
  if (loading.value || forgetting.value) return
  rememberChoiceChanged.value = true
  preferRememberedPassword.value = false
  const revision = userStore.sessionRevision
  forgetting.value = true
  try {
    // Clear the saved record in main, then reset the local remembered state.
    const response = await window.api.forgetRememberedAccount()
    if (!mounted || revision !== userStore.sessionRevision) return
    if (!response.success) {
      ElMessage.error(i18nStore.t.login.rememberClearFail)
      return
    }
    formData.rememberAccount = false
    remembered.value = {
      email: '',
      hasSavedPassword: false,
      encryptionAvailable: remembered.value.encryptionAvailable,
      recordStatus: 'none'
    }
    ElMessage.success(i18nStore.t.login.rememberCleared)
  } catch {
    if (mounted && revision === userStore.sessionRevision)
      ElMessage.error(i18nStore.t.login.rememberClearFail)
  } finally {
    if (mounted) forgetting.value = false
  }
}

function onRememberChange(value: unknown): void {
  rememberChoiceChanged.value = true
  if (value === false) void forgetRememberedAccount()
}

const handleLogin = async () => {
  if (!formRef.value || loading.value || forgetting.value) return
  const revision = userStore.sessionRevision
  loading.value = true
  let attempt: number | undefined
  try {
    const valid = await formRef.value.validate().catch(() => false)
    if (!valid || !mounted || revision !== userStore.sessionRevision) return
    const email = formData.email
    const password = formData.password
    const useSaved = usingRememberedPassword.value
    const options: LoginOptionsDTO | undefined = formData.rememberAccount
      ? { rememberAccount: true }
      : rememberChoiceChanged.value
        ? { rememberAccount: false }
        : undefined
    attempt = userStore.beginAuthentication()
    ownedAttempt = attempt
    // Use the remembered password when available, otherwise the typed password.
    const res = useSaved
      ? await window.api.loginRemembered(email, options)
      : await window.api.login(email, password, options)
    if (!mounted || !userStore.isCurrentAuthentication(attempt)) return
    if (!res.success || !res.data || !Number.isSafeInteger(res.data.id) || res.data.id <= 0) {
      if (useSaved) {
        preferRememberedPassword.value = false
        ElMessage.error(i18nStore.t.login.rememberedLoginFail)
      } else {
        ElMessage.error(
          res.code === 'AUTH_FAILED'
            ? i18nStore.t.login.loginFail
            : res.message || i18nStore.t.login.loginFail
        )
      }
      userStore.cancelAuthentication(attempt)
      return
    }
    // Establish the session, then route to the intended protected page.
    if (!userStore.completeAuthentication(res.data, attempt)) return
    ownedAttempt = undefined
    formData.password = ''
    if (res.data.rememberedAccount?.error) {
      ElMessage.warning(
        options?.rememberAccount === false
          ? i18nStore.t.login.rememberClearFail
          : i18nStore.t.login.rememberSaveFail
      )
    }
    ElMessage.success(i18nStore.t.login.loginSuccess)
    loading.value = false
    await router.replace(getSafeLoginRedirect(router, route.query.redirect))
  } catch {
    if (mounted && attempt !== undefined && userStore.isCurrentAuthentication(attempt)) {
      userStore.cancelAuthentication(attempt)
      if (typeof window.api?.logout === 'function') void window.api.logout().catch(() => undefined)
      ElMessage.error(i18nStore.t.login.loginFail)
    }
  } finally {
    if (attempt !== undefined && userStore.isCurrentAuthentication(attempt))
      userStore.cancelAuthentication(attempt)
    if (mounted) loading.value = false
  }
}
</script>

<template>
  <section class="auth-card" aria-labelledby="login-title">
    <div class="auth-card-heading">
      <span class="auth-card-icon" aria-hidden="true">
        <span class="i-ep-sunny"></span>
      </span>
      <h1 id="login-title" class="auth-card-title">{{ i18nStore.t.login.title }}</h1>
      <p class="auth-card-subtitle">{{ i18nStore.t.login.subtitle }}</p>
    </div>
    <el-form
      ref="formRef"
      :model="formData"
      :rules="rules"
      label-position="top"
      class="custom-form"
      @submit.prevent="handleLogin"
    >
      <el-form-item :label="i18nStore.t.login.email" prop="email">
        <EmailInput
          v-model="formData.email"
          autocomplete="email"
          :disabled="loading || forgetting"
          data-testid="login-email"
        />
      </el-form-item>
      <el-form-item :label="i18nStore.t.login.password" prop="password">
        <el-input
          v-model="formData.password"
          type="password"
          :show-password="!usingRememberedPassword"
          :disabled="loading || forgetting"
          autocomplete="current-password"
          :placeholder="
            usingRememberedPassword ? i18nStore.t.login.rememberedPlaceholder : '••••••••'
          "
          data-testid="login-password"
        />
      </el-form-item>
      <p
        v-if="usingRememberedPassword"
        class="remembered-password"
        data-testid="remembered-password-note"
      >
        {{ i18nStore.t.login.rememberedPassword }}
      </p>
      <button
        v-else-if="canUseRemembered && !formData.password"
        type="button"
        class="remember-link"
        @click="useRememberedPassword"
      >
        {{ i18nStore.t.login.useRememberedPassword }}
      </button>
      <div class="remember-setting">
        <el-checkbox
          v-model="formData.rememberAccount"
          :disabled="loading || forgetting || !remembered.encryptionAvailable"
          data-testid="remember-account"
          @change="onRememberChange"
          >{{ i18nStore.t.login.rememberAccount }}</el-checkbox
        >
        <button
          v-if="remembered.recordStatus !== 'none'"
          type="button"
          class="remember-link"
          :disabled="loading || forgetting"
          data-testid="forget-account"
          @click="forgetRememberedAccount"
        >
          {{ i18nStore.t.login.forgetRememberedAccount }}
        </button>
      </div>
      <p class="remember-hint">
        {{
          remembered.encryptionAvailable
            ? i18nStore.t.login.rememberHint
            : i18nStore.t.login.rememberUnavailable
        }}
      </p>
      <p v-if="remembered.recordStatus === 'damaged'" class="remember-hint">
        {{ i18nStore.t.login.rememberDamaged }}
      </p>
      <div class="auth-actions">
        <button
          type="submit"
          class="btn-primary"
          :disabled="loading || forgetting"
          :aria-busy="loading"
          data-testid="login-submit"
        >
          <span v-if="loading" class="i-ep-loading animate-spin" aria-hidden="true"></span>
          {{ loading ? i18nStore.t.login.loading : i18nStore.t.login.loginBtn }}
          <span v-if="!loading" class="i-ep-right" aria-hidden="true"></span>
        </button>
        <p class="auth-switch">
          {{ i18nStore.t.login.noAccount }}
          <router-link
            class="text-link ml-1"
            to="/register"
            :aria-disabled="loading || forgetting"
            @click="
              (event) => {
                if (loading || forgetting) event.preventDefault()
              }
            "
          >
            {{ i18nStore.t.login.goRegister }}
          </router-link>
        </p>
      </div>
    </el-form>
  </section>
</template>

<style scoped>
.remember-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
}
.remember-link {
  border: 0;
  padding: 0;
  background: transparent;
  color: #286a51;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.remember-link:disabled {
  opacity: 0.55;
  cursor: default;
}
.remember-hint {
  margin: 6px 0 0;
  color: #607780;
  font-size: 12px;
  line-height: 1.65;
}
.remembered-password {
  margin: -8px 0 8px;
  color: #286a51;
  font-size: 12px;
  line-height: 1.65;
}
</style>
