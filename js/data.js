// 세교2지구 샘플 데이터 (SAMPLE).
// 좌표·세대수·정원은 개발용 가상값입니다. 실제 입주계획/시설 데이터 확보 후 이 파일만 교체하세요.
// 교체 대상: COMPLEXES(입주계획), FACILITIES(학교·정류장·공원), 모델 계수는 model.js의 PARAMS.

export const CENTER = [37.1905, 127.0330];
export const YEARS = [2026, 2027, 2028, 2029, 2030];

// phases: [입주연도, 세대수]
export const COMPLEXES = [
  { id: "A1", name: "세교2 A1블록", lat: 37.1965, lng: 127.0255, phases: [[2026, 900], [2027, 300]] },
  { id: "A2", name: "세교2 A2블록", lat: 37.1950, lng: 127.0330, phases: [[2026, 1100]] },
  { id: "A3", name: "세교2 A3블록", lat: 37.1940, lng: 127.0410, phases: [[2027, 1200]] },
  { id: "A4", name: "세교2 A4블록", lat: 37.1915, lng: 127.0270, phases: [[2026, 700], [2028, 500]] },
  { id: "B1", name: "세교2 B1블록", lat: 37.1905, lng: 127.0350, phases: [[2027, 800], [2028, 400]] },
  { id: "B2", name: "세교2 B2블록", lat: 37.1895, lng: 127.0430, phases: [[2028, 1300]] },
  { id: "B3", name: "세교2 B3블록", lat: 37.1870, lng: 127.0290, phases: [[2026, 600], [2029, 600]] },
  { id: "C1", name: "세교2 C1블록", lat: 37.1860, lng: 127.0370, phases: [[2028, 900], [2029, 500]] },
  { id: "C2", name: "세교2 C2블록", lat: 37.1850, lng: 127.0450, phases: [[2029, 1200]] },
  { id: "D1", name: "세교2 D1블록", lat: 37.1825, lng: 127.0310, phases: [[2029, 800], [2030, 600]] },
  { id: "D2", name: "세교2 D2블록", lat: 37.1815, lng: 127.0400, phases: [[2030, 1100]] },
  { id: "D3", name: "세교2 D3블록", lat: 37.1800, lng: 127.0470, phases: [[2030, 900]] },
];

// type: school(level: elem|mid|high, cap 정원) | bus(cap 첨두시 수송력) | park(area ㎡)
// open: 개통/개교 연도
export const FACILITIES = [
  { id: "S1", type: "school", level: "elem", name: "세교2초(가칭)", lat: 37.1950, lng: 127.0290, cap: 900, open: 2026 },
  { id: "S2", type: "school", level: "elem", name: "세교초", lat: 37.1885, lng: 127.0400, cap: 700, open: 2026 },
  { id: "S3", type: "school", level: "mid", name: "세교중", lat: 37.1930, lng: 127.0370, cap: 800, open: 2026 },
  { id: "S4", type: "school", level: "high", name: "세교고", lat: 37.1880, lng: 127.0320, cap: 900, open: 2026 },

  { id: "B1", type: "bus", name: "세교2 입구 정류장", lat: 37.1955, lng: 127.0300, cap: 500, open: 2026 },
  { id: "B2", type: "bus", name: "중앙 정류장", lat: 37.1910, lng: 127.0345, cap: 500, open: 2026 },
  { id: "B3", type: "bus", name: "동측 정류장", lat: 37.1890, lng: 127.0440, cap: 450, open: 2026 },
  { id: "B4", type: "bus", name: "남측 정류장", lat: 37.1860, lng: 127.0300, cap: 450, open: 2027 },

  { id: "P1", type: "park", name: "세교 근린공원", lat: 37.1925, lng: 127.0290, area: 30000, open: 2026 },
  { id: "P2", type: "park", name: "오산천 변 공원", lat: 37.1870, lng: 127.0420, area: 22000, open: 2026 },
];
