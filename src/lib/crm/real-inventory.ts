/**
 * Live inventory from Paul Motor Leasing website:
 * https://www.paulmotorleasing.com/vehicles/used/?st=price,desc&view=grid&sc=used
 *
 * Stock numbers are the dealership codes shown on each listing.
 * When the site omits Stock #, we use the published VIN (same pattern as some listings).
 * Snapshot refreshed Aug 2026 — 16 units (full grid).
 */
export type RealVehicle = {
  year: number;
  make: string;
  model: string;
  trim: string | null;
  stock_number: string;
  vin?: string | null;
  price: number;
  mileage: number;
  body_type: string | null;
  exterior_color?: string | null;
  external_url: string;
  notes?: string;
};

export const PAUL_MOTOR_INVENTORY_SOURCE =
  "https://www.paulmotorleasing.com/vehicles/used/?st=price,desc&view=grid&sc=used";

export const REAL_INVENTORY: RealVehicle[] = [
  {
    year: 2015,
    make: "Ferrari",
    model: "458",
    trim: "Speciale (2-Owner)",
    stock_number: "19064",
    price: 1749000,
    mileage: 1162,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2015/ferrari/458/verdun/qc/69467045/",
    notes: "Paul Motor Leasing website · Stock #19064",
  },
  {
    year: 2024,
    make: "Ferrari",
    model: "Purosangue",
    trim: "AWD",
    stock_number: "18160",
    price: 699900,
    mileage: 8539,
    body_type: "SUV",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2024/ferrari/purosangue/verdun/qc/69467049/",
    notes: "Paul Motor Leasing website · Stock #18160",
  },
  {
    year: 2024,
    make: "Rolls-Royce",
    model: "Spectre",
    trim: "Coupe",
    stock_number: "SCATK2C02RU224642",
    vin: "SCATK2C02RU224642",
    price: 489900,
    mileage: 12950,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2024/rolls-royce/spectre/verdun/qc/70894409/",
    notes: "Paul Motor Leasing website · Stock # not listed — VIN used",
  },
  {
    year: 2001,
    make: "BMW",
    model: "Z8",
    trim: "Hard Top included",
    stock_number: "18165",
    price: 289500,
    mileage: 24579,
    body_type: "Roadster",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2001/bmw/z8/verdun/qc/66789868/",
    notes: "Paul Motor Leasing website · Stock #18165",
  },
  {
    year: 2025,
    make: "Porsche",
    model: "Taycan",
    trim: "Turbo GT Weissach Package",
    stock_number: "WP0AE2Y12SSA58054",
    vin: "WP0AE2Y12SSA58054",
    price: 279750,
    mileage: 3584,
    body_type: "Sedan",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2025/porsche/taycan/verdun/qc/70768118/",
    notes: "Paul Motor Leasing website · Stock # not listed — VIN used",
  },
  {
    year: 2019,
    make: "McLaren",
    model: "600LT",
    trim: "Senna seats / Carbon exterior pack",
    stock_number: "14067",
    price: 274995,
    mileage: 16569,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2019/mclaren/600/verdun/qc/68627815/",
    notes: "Paul Motor Leasing website · Stock #14067",
  },
  {
    year: 2023,
    make: "Audi",
    model: "R8",
    trim: "Coupe Performance · Fi Exhaust",
    stock_number: "WUACEAFX3P7900954",
    vin: "WUACEAFX3P7900954",
    price: 219554,
    mileage: 15485,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2023/audi/r8-coupe/verdun/qc/70770349/",
    notes: "Paul Motor Leasing website · Stock # not listed — VIN used",
  },
  {
    year: 2018,
    make: "Mercedes-Benz",
    model: "G-Class",
    trim: "G 550 4x4",
    stock_number: "16111",
    price: 158550,
    mileage: 102582,
    body_type: "SUV",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2018/mercedes-benz/g-class/verdun/qc/66679163/",
    notes: "Paul Motor Leasing website · Stock #16111",
  },
  {
    year: 2021,
    make: "Porsche",
    model: "Cayman",
    trim: "718 GT4",
    stock_number: "18022",
    price: 155718,
    mileage: 27916,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2021/porsche/cayman-718-gt4/verdun/qc/69597207/",
    notes: "Paul Motor Leasing website · Stock #18022",
  },
  {
    year: 2019,
    make: "Aston Martin",
    model: "Vantage",
    trim: "Coupe",
    stock_number: "SCFSMGAW5KGN00739",
    vin: "SCFSMGAW5KGN00739",
    price: 125007,
    mileage: 27681,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2019/aston-martin/vantage/verdun/qc/70820298/",
    notes: "Paul Motor Leasing website · Stock #SCFSMGAW5KGN00739",
  },
  {
    year: 2019,
    make: "Bentley",
    model: "Bentayga",
    trim: "AWD",
    stock_number: "14172",
    price: 94500,
    mileage: 124786,
    body_type: "SUV",
    exterior_color: "White",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2019/bentley/bentayga/verdun/qc/58085799/",
    notes: "Paul Motor Leasing website · Stock #14172",
  },
  {
    year: 2017,
    make: "Bentley",
    model: "Bentayga",
    trim: "W12",
    stock_number: "13138",
    price: 94500,
    mileage: 86375,
    body_type: "SUV",
    exterior_color: "Black",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2017/bentley/bentayga/verdun/qc/70418996/",
    notes: "Paul Motor Leasing website · Stock #13138",
  },
  {
    year: 2023,
    make: "Land Rover",
    model: "Defender",
    trim: "75th Edition",
    stock_number: "17072",
    price: 74775,
    mileage: 22866,
    body_type: "SUV",
    exterior_color: "Green",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2023/land-rover/defender/verdun/qc/70416824/",
    notes: "Paul Motor Leasing website · Stock #17072",
  },
  {
    year: 2020,
    make: "BMW",
    model: "8 Series",
    trim: "M850i xDrive Coupe",
    stock_number: "16191",
    price: 65800,
    mileage: 40872,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2020/bmw/8-series/verdun/qc/68902571/",
    notes: "Paul Motor Leasing website · Stock #16191",
  },
  {
    year: 2020,
    make: "Porsche",
    model: "Cayenne",
    trim: 'S Prem+ · 21" RS · Sport Exhaust',
    stock_number: "17044",
    price: 64850,
    mileage: 54761,
    body_type: "SUV",
    exterior_color: "White",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2020/porsche/cayenne/verdun/qc/69297781/",
    notes: "Paul Motor Leasing website · Stock #17044",
  },
  {
    year: 2017,
    make: "Mercedes-Benz",
    model: "Metris",
    trim: "Passenger Van Worker",
    stock_number: "WDAPG2EEXH3328324",
    vin: "WDAPG2EEXH3328324",
    price: 38750,
    mileage: 150300,
    body_type: "Van",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2017/mercedes-benz/metris-passenger-van/verdun/qc/70894904/",
    notes: "Paul Motor Leasing website · Stock # not listed — VIN used",
  },
];
