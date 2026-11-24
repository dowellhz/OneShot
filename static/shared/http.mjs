export async function fetchJSON(url, method = "GET", body) {
  const options = {method};
  if (body instanceof FormData) {
    options.body = body;
  } else if (body) {
    options.headers = {"Content-Type": "application/json"};
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const value = await response.json().catch(() => null);
  return {response, value};
}
