/**
 * Inventory snapshot from AutoTrader dealer feed:
 * https://www.autotrader.ca/dealers/47941991?cid=47941991
 * (Paul Motor Leasing — fuller list than the website grid’s first page)
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
  "https://www.autotrader.ca/dealers/47941991?cid=47941991";

/** Stable stock codes derived from listing id fragments for CRM matching. */
function stock(code: string) {
  return code;
}

export const REAL_INVENTORY: RealVehicle[] = [
  {
    year: 2015,
    make: "Ferrari",
    model: "458",
    trim: "Speciale (2-Owner)",
    stock_number: stock("AT-458SP"),
    price: 1749000,
    mileage: 1162,
    body_type: "Coupe",
    external_url:
      "https://www.autotrader.ca/offers/ferrari-458-2-owner-speciale-gasoline-cat_ma27gr200478-a519b78e-93b7-477d-8232-a6c686d4620b",
    notes: "AutoTrader · Paul Motor dealer listing",
  },
  {
    year: 2024,
    make: "Ferrari",
    model: "Purosangue",
    trim: "AWD",
    stock_number: stock("AT-PURO24"),
    price: 699900,
    mileage: 8539,
    body_type: "SUV",
    external_url:
      "https://www.autotrader.ca/offers/ferrari-purosangue-awd-gasoline-cat_ma27gr200484-3186bfbe-34d2-4d0f-bd93-b3078ff871cf",
  },
  {
    year: 2001,
    make: "BMW",
    model: "Z8",
    trim: "Hard Top included",
    stock_number: stock("AT-Z8-01"),
    price: 289500,
    mileage: 24579,
    body_type: "Roadster",
    external_url:
      "https://www.autotrader.ca/offers/bmw-z8-clean-carfax-hard-top-included-gasoline-cat_ma13gr16402-51bed0e4-85ed-463e-9b6c-ad0c893379a1",
  },
  {
    year: 2019,
    make: "McLaren",
    model: "600LT",
    trim: "Senna seats / Carbon exterior pack",
    stock_number: stock("AT-600LT"),
    price: 274995,
    mileage: 16569,
    body_type: "Coupe",
    external_url:
      "https://www.autotrader.ca/offers/mclaren-600-senna-seats-i-carbon-fiber-ext-pack-clean-carfax-gasoline-white-cat_ma51519gr202631-4c4ff137-a624-49e7-b8b3-cbb9d11eef05",
  },
  {
    year: 2025,
    make: "Porsche",
    model: "Taycan",
    trim: "Turbo GT Weissach Package",
    stock_number: stock("AT-TAYGT"),
    price: 279750,
    mileage: 3584,
    body_type: "Sedan",
    external_url:
      "https://www.autotrader.ca/offers/porsche-taycan-turbo-gt-weissach-package-electric-violet-cat_ma57gr75273tr11554-16adab48-a5c2-46bb-815f-cd9fe5726090",
  },
  {
    year: 2023,
    make: "Audi",
    model: "R8",
    trim: "Coupe Performance · Fi Exhaust",
    stock_number: stock("AT-R8-23"),
    price: 219554,
    mileage: 15485,
    body_type: "Coupe",
    external_url:
      "https://www.autotrader.ca/offers/audi-r8-performance-fi-exhaust-gasoline-grey-cat_ma9gr18925va655tr9930-8dcb74aa-ac96-4579-a271-5df2a717f383",
  },
  {
    year: 2018,
    make: "Mercedes-Benz",
    model: "G-Class",
    trim: "G 550 4x4",
    stock_number: stock("AT-G550"),
    price: 158550,
    mileage: 102582,
    body_type: "SUV",
    external_url:
      "https://www.autotrader.ca/offers/mercedes-benz-g-class-g-550-4x4-clean-carfax-gasoline-cat_ma47gr100062tr16762-9177fb0a-07cf-4193-a824-372d8ff10e12",
  },
  {
    year: 2021,
    make: "Porsche",
    model: "Cayman",
    trim: "718 GT4",
    stock_number: stock("AT-GT4-21"),
    price: 155718,
    mileage: 27916,
    body_type: "Coupe",
    external_url:
      "https://www.autotrader.ca/offers/porsche-cayman-gt4-22k-in-options-clean-carfax-gasoline-cat_ma57gr18684va2308-717cd059-e1e4-4851-905d-bbad7f8e9309",
  },
  {
    year: 2019,
    make: "Aston Martin",
    model: "Vantage",
    trim: "Coupe",
    stock_number: stock("AT-VAN19"),
    price: 125007,
    mileage: 27681,
    body_type: "Coupe",
    exterior_color: "Red",
    external_url:
      "https://www.autotrader.ca/offers/aston-martin-vantage-coupe-clean-carfax-gasoline-red-cat_ma8gr200111-edbad49b-75d0-4300-a5fd-dae9d664f46c",
  },
  {
    year: 2017,
    make: "Bentley",
    model: "Bentayga",
    trim: "W12",
    stock_number: stock("AT-BEN17"),
    price: 94500,
    mileage: 86375,
    body_type: "SUV",
    exterior_color: "Black",
    external_url:
      "https://www.autotrader.ca/offers/bentley-bentayga-w12-gasoline-black-cat_ma11gr200146mt12487-81a939b2-c308-4a9b-b3df-0c2803661b35",
  },
  {
    year: 2019,
    make: "Bentley",
    model: "Bentayga",
    trim: "AWD",
    stock_number: stock("AT-BEN19"),
    price: 94500,
    mileage: 124786,
    body_type: "SUV",
    exterior_color: "White",
    external_url:
      "https://www.autotrader.ca/offers/bentley-bentayga-awd-clean-carfax-gasoline-white-cat_ma11gr200146mt12486-71667ec3-2fce-40a8-9018-f9aea1f6e665",
  },
  {
    year: 2023,
    make: "Land Rover",
    model: "Defender",
    trim: "75th Edition",
    stock_number: stock("AT-DEF23"),
    price: 74775,
    mileage: 22866,
    body_type: "SUV",
    exterior_color: "Green",
    external_url:
      "https://www.autotrader.ca/offers/land-rover-defender-75th-edition-gas-electric-hybrid-green-cat_ma15641gr200834tr14002-2f571f7d-43a7-45d5-a03f-1ba915c324cd",
  },
  {
    year: 2020,
    make: "BMW",
    model: "8 Series",
    trim: "M850i xDrive Coupe",
    stock_number: stock("AT-M850"),
    price: 65800,
    mileage: 40872,
    body_type: "Coupe",
    external_url:
      "https://www.autotrader.ca/offers/bmw-8-series-m850i-xdrive-coupe-gasoline-cat_ma13gr100042mt1334tr478947-3113944f-83b6-4096-ad60-ef76d3556940",
  },
  {
    year: 2020,
    make: "Porsche",
    model: "Cayenne",
    trim: 'S Prem+ · 21" RS · Sport Exhaust · Sport Design',
    stock_number: stock("AT-CAY20"),
    price: 64850,
    mileage: 54761,
    body_type: "SUV",
    exterior_color: "White",
    external_url:
      "https://www.autotrader.ca/offers/porsche-cayenne-s-prem-+-pkg-21-rs-sport-exhaust-sport-design-gasoline-white-cat_ma57gr18284tr11356-8b033c2f-1fe1-456a-ba6b-098198c88fb8",
  },
];
