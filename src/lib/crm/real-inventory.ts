/**
 * Live inventory snapshot from paulmotorleasing.com/vehicles (scraped 2026-07-29).
 * Refresh button re-upserts this list; a production scraper can replace the source later.
 */
export type RealVehicle = {
  year: number;
  make: string;
  model: string;
  trim: string | null;
  stock_number: string;
  price: number;
  mileage: number;
  body_type: string | null;
  exterior_color?: string | null;
  external_url: string;
  notes?: string;
};

export const PAUL_MOTOR_INVENTORY_SOURCE =
  "https://www.paulmotorleasing.com/vehicles/";

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
      "https://www.paulmotorleasing.com/vehicles/2015/ferrari/458/verdun/qc/69467045/?sale_class=used",
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
      "https://www.paulmotorleasing.com/vehicles/2024/ferrari/purosangue/verdun/qc/69467049/?sale_class=used",
  },
  {
    year: 2001,
    make: "BMW",
    model: "Z8",
    trim: "Hard Top included",
    stock_number: "18165",
    price: 289500,
    mileage: 24579,
    body_type: "Convertible",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2001/bmw/z8/verdun/qc/66789868/?sale_class=used",
  },
  {
    year: 2025,
    make: "Porsche",
    model: "Taycan",
    trim: "Turbo GT Weissach Package",
    stock_number: "TAY-GT-25",
    price: 279750,
    mileage: 3584,
    body_type: "Sedan",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2025/porsche/taycan/verdun/qc/70768118/?sale_class=used",
  },
  {
    year: 2019,
    make: "McLaren",
    model: "600LT",
    trim: "Senna Seats / Carbon Fiber",
    stock_number: "14067",
    price: 274995,
    mileage: 16569,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2019/mclaren/600/verdun/qc/68627815/?sale_class=used",
  },
  {
    year: 2023,
    make: "Audi",
    model: "R8",
    trim: "Coupe Performance · Fi Exhaust",
    stock_number: "R8-23",
    price: 219554,
    mileage: 15485,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2023/audi/r8-coupe/verdun/qc/70770349/?sale_class=used",
  },
  {
    year: 2018,
    make: "Mercedes-Benz",
    model: "G-Class",
    trim: "G 550 4x4²",
    stock_number: "16111",
    price: 158550,
    mileage: 102582,
    body_type: "SUV",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2018/mercedes-benz/g-class/verdun/qc/66679163/?sale_class=used",
  },
  {
    year: 2021,
    make: "Porsche",
    model: "718 Cayman",
    trim: "GT4 ($22k options)",
    stock_number: "18022",
    price: 155718,
    mileage: 27916,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2021/porsche/cayman-718-gt4/verdun/qc/69597207/?sale_class=used",
  },
  {
    year: 2019,
    make: "Aston Martin",
    model: "Vantage",
    trim: "Coupe",
    stock_number: "SCFSMGAW5KGN00739",
    price: 125007,
    mileage: 27681,
    body_type: "Coupe",
    external_url:
      "https://www.paulmotorleasing.com/vehicles/2019/aston-martin/vantage/verdun/qc/",
    notes: "Clean Carfax",
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
    external_url: "https://www.paulmotorleasing.com/vehicles/",
    notes: "Clean Carfax",
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
    external_url: "https://www.paulmotorleasing.com/vehicles/",
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
    external_url: "https://www.paulmotorleasing.com/vehicles/",
  },
];
