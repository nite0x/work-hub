'use strict';
const params = new URLSearchParams(location.search);
if (params.has('error')) {
  document.getElementById('title').textContent = '暂时无法打开工作台';
  document.getElementById('message').textContent = params.get('error');
}
