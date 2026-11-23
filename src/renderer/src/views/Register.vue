<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus'
import { useI18nStore } from '@renderer/store/i18n'
import { useSessionOperation } from '@renderer/composables/useSessionOperation'

const router = useRouter()
const operations = useSessionOperation()
const i18nStore = useI18nStore()
const formRef = ref<FormInstance>()
const loading = ref(false)

const formData = reactive({
  nickname: '',
  email: '',
  password: '',
  confirmPassword: ''
})

const rules = computed<FormRules>(() => ({
  nickname: [
    { required: true, message: i18nStore.t.register.nickReq, trigger: 'blur' },
    { min: 2, max: 20, message: i18nStore.t.register.nickLen, trigger: 'blur' }
  ],
  email: [
    { required: true, message: i18nStore.t.login.emailReq, trigger: 'blur' },
    { type: 'email', message: i18nStore.t.login.emailInvalid, trigger: 'blur' }
  ],
  password: [
    { required: true, message: i18nStore.t.login.passReq, trigger: 'blur' },
    { min: 8, message: i18nStore.t.register.passMin, trigger: 'blur' }
  ],
  confirmPassword: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        if (value !== formData.password) callback(new Error(i18nStore.t.register.passMatch))
        else callback()
      },
      trigger: 'blur'
    }
  ]
}))

const handleRegister = async () => {
  if (!formRef.value || loading.value) return

  const operation = operations.capture()
  if (!operation.isActive()) return
  loading.value = true
  try {
    const valid = await formRef.value.validate().catch(() => false)
    if (!valid || !operation.isActive()) return
    // The frontend nickname maps to the backend name field (see CreateUserSchema).
    const email = formData.email
    const res = await operation.call(() =>
      window.api.createUser({
        name: formData.nickname,
        email,
        password: formData.password
      })
    )

    if (!operation.isActive() || !res) return
    if (!res.success) {
      // EMAIL_EXISTS comes from the IPC pre-check; DATA_EXISTS is the unique-constraint fallback.
      const isEmailTaken = res.code === 'EMAIL_EXISTS' || res.code === 'DATA_EXISTS'
      ElMessage.error(
        isEmailTaken
          ? i18nStore.t.register.emailExists
          : res.message || i18nStore.t.register.regFail
      )
      return
    }

    ElMessage.success(i18nStore.t.register.regSuccess)
    // Navigate to the login page, passing the registered email via the query string.
    router.push({
      path: '/login',
      query: { email }
    })
  } catch {
    if (operation.isActive()) ElMessage.error(i18nStore.t.register.regFail)
  } finally {
    if (operation.isActive()) loading.value = false
  }
}
</script>

<template>
  <section class="auth-card auth-card-register" aria-labelledby="register-title">
    <div class="auth-card-heading">
      <h1 id="register-title" class="auth-card-title">{{ i18nStore.t.register.title }}</h1>
      <p class="auth-card-subtitle">{{ i18nStore.t.register.subtitle }}</p>
    </div>
    <el-form
      ref="formRef"
      :model="formData"
      :rules="rules"
      label-position="top"
      class="custom-form"
      @submit.prevent="handleRegister"
    >
      <el-form-item :label="i18nStore.t.register.nickname" prop="nickname">
        <el-input
          v-model="formData.nickname"
          autocomplete="nickname"
          :placeholder="i18nStore.t.register.nickPlace"
        />
      </el-form-item>
      <el-form-item :label="i18nStore.t.register.email" prop="email">
        <EmailInput v-model="formData.email" autocomplete="email" />
      </el-form-item>
      <el-form-item :label="i18nStore.t.register.password" prop="password">
        <el-input
          v-model="formData.password"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="••••••••"
        />
      </el-form-item>
      <el-form-item :label="i18nStore.t.register.confirmPass" prop="confirmPassword">
        <el-input
          v-model="formData.confirmPassword"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="••••••••"
        />
      </el-form-item>
      <div class="auth-actions">
        <button type="submit" class="btn-primary" :disabled="loading" :aria-busy="loading">
          <span v-if="loading" class="i-ep-loading animate-spin" aria-hidden="true"></span>
          {{ loading ? i18nStore.t.register.loading : i18nStore.t.register.signupBtn }}
          <span v-if="!loading" class="i-ep-right" aria-hidden="true"></span>
        </button>
        <p class="auth-switch">
          {{ i18nStore.t.register.hasAccount }}
          <router-link class="text-link ml-1" to="/login">
            {{ i18nStore.t.register.goLogin }}
          </router-link>
        </p>
      </div>
    </el-form>
  </section>
</template>
