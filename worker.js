importScripts('dsp.js', 'world.js');
onmessage = ({ data }) => {
  try {
    const result = DSP.run(data, v => postMessage({ type: 'progress', v }));
    postMessage({ type: 'done', result });
  } catch (e) { postMessage({ type: 'error', message: e.message }); }
};
