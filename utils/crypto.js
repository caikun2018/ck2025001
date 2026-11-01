// utils/crypto.js - 本地存储的轻量混淆（**不是加密**）
//
// 安全提示：XOR + Base64 是可逆混淆，任何人拿到本地存储都能还原原值。
// 它的作用只是避免 API Key 以明文直接出现在 Storage 面板里，
// 请不要当作安全措施使用。真正保护凭据应放在服务端下发，或使用微信的加密能力。
//
// SECRET 对仓库读者完全可见，部署时应换成自建值。
// 生产环境建议使用 wx.getStorage 配合加密插件，此处仅为演示骨架

const SECRET = 'cuoti-zhilian-2026'

// 简单异或 + base64
const encrypt = (text) => {
  if (!text) return ''
  try {
    let result = ''
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(text.charCodeAt(i) ^ SECRET.charCodeAt(i % SECRET.length))
    }
    return wx.arrayBufferToBase64(stringToArrayBuffer(result))
  } catch (e) {
    return text
  }
}

const decrypt = (encoded) => {
  if (!encoded) return ''
  try {
    const buffer = wx.base64ToArrayBuffer(encoded)
    const str = arrayBufferToString(buffer)
    let result = ''
    for (let i = 0; i < str.length; i++) {
      result += String.fromCharCode(str.charCodeAt(i) ^ SECRET.charCodeAt(i % SECRET.length))
    }
    return result
  } catch (e) {
    return encoded
  }
}

function stringToArrayBuffer(str) {
  const buf = new ArrayBuffer(str.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i)
  return buf
}

function arrayBufferToString(buf) {
  return String.fromCharCode.apply(null, new Uint8Array(buf))
}

module.exports = { encrypt, decrypt }
