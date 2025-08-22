async function load() {
  const res = await fetch('/status');
  if (!res.ok) {
    window.location = '/login.html';
    return;
  }
  const data = await res.json();
  const tbl = document.getElementById('lines');
  tbl.innerHTML = '<tr><th>Линия</th><th>Скорость</th><th>Статус</th></tr>';
  data.forEach(l => {
    tbl.innerHTML += `<tr><td>${l.name}</td><td>${l.speed ?? '-'}</td><td>${l.state}</td></tr>`;
  });
}
setInterval(load, 5000);
load();
