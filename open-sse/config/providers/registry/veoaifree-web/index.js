export const veoaifree_webProvider = {
  id: "veoaifree-web",
  alias: "veo-free",
  format: "openai",
  executor: "veoaifree-web",
  baseUrl: "https://veoaifree.com/wp-admin/admin-ajax.php",
  authType: "none",
  authHeader: "none",
  models: [{
    id: "veo",
    name: "VEO 3.1"
  }, {
    id: "seedance",
    name: "Seedance"
  }]
};