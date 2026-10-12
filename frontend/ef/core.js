(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EFStudioCore = factory();
})(typeof window === 'undefined' ? this : window, function () {
  'use strict';
  function createStreamParser(onEvent) {
    let buffer = '';
    function line(text) {
      if (!text.trim()) return;
      const event = JSON.parse(text);
      if (!event || typeof event.name !== 'string' || !event.payload) throw new Error('Invalid runtime event');
      onEvent(event);
    }
    return {
      push(chunk) {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) throw new Error('Runtime event exceeds the preview limit');
        let at;
        while ((at = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
      },
      finish() { line(buffer); buffer = ''; }
    };
  }
  function runLabel(reason) {
    return ({ done: 'Completed', max_iters: 'Iteration limit reached', budget: 'Budget limit reached', cancelled: 'Stopped', error: 'Failed', refusal: 'Declined', empty: 'No response', clarifying: 'Needs clarification' })[reason] || 'Outcome unconfirmed';
  }
  function makeRun(form) {
    if (!String(form.model || '').trim()) throw new Error('Enter a model ID.');
    if (!String(form.prompt || '').trim()) throw new Error('Describe the task first.');
    const allowed = new Set(['dish', 'cabinet', 'notebook']);
    return {
      agentId: form.agentId || 'agent', provider: form.provider,
      model: String(form.model).trim(), key: form.key || '',
      messages: [{ role: 'user', content: String(form.prompt).trim() }],
      system: 'You are an assistant in EF Ventures Agent Studio. Be clear, practical, and honest about what you have completed. Ask before making assumptions that change the task. Preserve original authorship and attribution.',
      isTask: true,
      placed: (form.capabilities || []).filter(x => allowed.has(x)),
    };
  }
  return { createStreamParser, runLabel, makeRun };
});
