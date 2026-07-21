export function validateWitchActionResources(action, {
  saveAvailable = false,
  poisonAvailable = false,
  killTargetId = null
} = {}) {
  if (!['pass', 'save', 'poison'].includes(action)) {
    return { ok: false, reason: '女巫动作不合法' };
  }
  if (action === 'save' && !saveAvailable) {
    return { ok: false, reason: '女巫解药已经使用，不能再次救人' };
  }
  if (action === 'save' && !killTargetId) {
    return { ok: false, reason: '本夜没有狼刀目标，不能使用解药' };
  }
  if (action === 'poison' && !poisonAvailable) {
    return { ok: false, reason: '女巫毒药已经使用，不能再次毒人' };
  }
  return { ok: true };
}
