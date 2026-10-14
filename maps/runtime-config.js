window.NNAPER_CONFIG = Object.assign({
  API_BASE_URL: 'http://localhost:8000',
  TILES_BASE_URL: 'http://localhost:8080',
  OSRM_URL: 'http://localhost:5000',
  PHOTON_URL: 'https://photon.komoot.io',
  PHOTON_BBOX: '14.1,53.9,19.9,55.9',
  PHOTON_SEARCH_LIMIT: 50,
  PMTILES_FILE: 'pomorskie.pmtiles'
}, window.NNAPER_CONFIG || {});