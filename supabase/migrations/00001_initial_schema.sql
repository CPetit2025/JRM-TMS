-- 00001_initial_schema.sql

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. ROLES AND USERS
CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- users will map to auth.users but we keep a local profile table
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    document_id VARCHAR(20), -- DNI/RUC
    role_id UUID REFERENCES roles(id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. CLIENTS
CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_name VARCHAR(255) NOT NULL,
    ruc VARCHAR(20) NOT NULL UNIQUE,
    commercial_name VARCHAR(255),
    contact_name VARCHAR(150),
    phone VARCHAR(50),
    email VARCHAR(150),
    address TEXT,
    city VARCHAR(100),
    department VARCHAR(100),
    status VARCHAR(20) DEFAULT 'ACTIVE', -- ACTIVE, INACTIVE
    observations TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. TRANSPORT BUDGETS (Partidas de transporte)
CREATE TABLE transport_budgets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    client_id UUID REFERENCES clients(id),
    budget_limit NUMERIC(10, 2), -- Optional for future use
    status VARCHAR(20) DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. WORK ORDERS (OTs)
CREATE TABLE work_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ot_number VARCHAR(50) NOT NULL UNIQUE,
    client_id UUID NOT NULL REFERENCES clients(id),
    transport_budget_id UUID NOT NULL REFERENCES transport_budgets(id),
    project_name VARCHAR(255),
    delivery_address TEXT NOT NULL,
    delivery_contact VARCHAR(150),
    delivery_phone VARCHAR(50),
    required_date TIMESTAMP WITH TIME ZONE NOT NULL,
    weight NUMERIC(10, 2),
    volume NUMERIC(10, 2),
    packages_count INTEGER,
    priority VARCHAR(20) DEFAULT 'NORMAL', -- BAJA, NORMAL, ALTA, URGENTE
    status VARCHAR(50) DEFAULT 'CREADA', -- CREADA, VALIDADA, DISPONIBLE, PROGRAMADA, EN_TRANSITO, ENTREGADA, CERRADA, CANCELADA
    observations TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by UUID REFERENCES profiles(id)
);

-- 5. CARRIERS (Transportistas)
CREATE TABLE carriers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(20) NOT NULL, -- PROPIO, TERCERO
    business_name VARCHAR(255) NOT NULL,
    ruc VARCHAR(20) NOT NULL UNIQUE,
    contact_name VARCHAR(150),
    phone VARCHAR(50),
    email VARCHAR(150),
    address TEXT,
    status VARCHAR(20) DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. VEHICLES (Unidades)
CREATE TABLE vehicles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plate VARCHAR(20) NOT NULL UNIQUE,
    carrier_id UUID NOT NULL REFERENCES carriers(id),
    type VARCHAR(50) NOT NULL,
    brand VARCHAR(100),
    model VARCHAR(100),
    year INTEGER,
    weight_capacity NUMERIC(10, 2),
    volume_capacity NUMERIC(10, 2),
    status VARCHAR(50) DEFAULT 'DISPONIBLE', -- DISPONIBLE, ASIGNADA, EN_RUTA, EN_MANTENIMIENTO, INACTIVA
    soat_expiration DATE,
    technical_review_expiration DATE,
    odometer NUMERIC(12, 2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. DRIVERS (Conductores)
CREATE TABLE drivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    carrier_id UUID NOT NULL REFERENCES carriers(id),
    profile_id UUID REFERENCES profiles(id), -- If they have access to the app
    document_id VARCHAR(20) NOT NULL UNIQUE, -- DNI
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(50),
    license_number VARCHAR(50) NOT NULL,
    license_category VARCHAR(20),
    license_expiration DATE,
    status VARCHAR(20) DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. DISPATCHES (Despachos - Programación)
CREATE TABLE dispatches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    dispatch_number VARCHAR(50) NOT NULL UNIQUE,
    scheduled_date TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(50) DEFAULT 'PROGRAMADO', -- PROGRAMADO, EN_RUTA, FINALIZADO, CERRADO
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. DISPATCH_WORK_ORDERS (Consolidación Despacho -> OTs)
CREATE TABLE dispatch_work_orders (
    dispatch_id UUID REFERENCES dispatches(id) ON DELETE CASCADE,
    work_order_id UUID REFERENCES work_orders(id) ON DELETE RESTRICT,
    sequence_order INTEGER,
    PRIMARY KEY (dispatch_id, work_order_id)
);

-- 10. ROUTES (Rutas - Ejecución del Despacho)
CREATE TABLE routes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    dispatch_id UUID NOT NULL REFERENCES dispatches(id),
    vehicle_id UUID NOT NULL REFERENCES vehicles(id),
    driver_id UUID NOT NULL REFERENCES drivers(id),
    status VARCHAR(50) DEFAULT 'ASIGNADA', -- ASIGNADA, CHECKLIST_PENDIENTE, ACTIVA, EN_TRANSITO, FINALIZADA
    start_time TIMESTAMP WITH TIME ZONE,
    end_time TIMESTAMP WITH TIME ZONE,
    start_odometer NUMERIC(12, 2),
    end_odometer NUMERIC(12, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 11. ROUTE_STOPS (Puntos de entrega)
CREATE TABLE route_stops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_id UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    work_order_id UUID NOT NULL REFERENCES work_orders(id),
    sequence_order INTEGER NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDIENTE', -- PENDIENTE, LLEGADA, ENTREGADO, RECHAZADO, INCIDENCIA
    arrival_time TIMESTAMP WITH TIME ZONE,
    departure_time TIMESTAMP WITH TIME ZONE,
    arrival_odometer NUMERIC(12, 2),
    observations TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 12. EVIDENCES (Evidencias)
CREATE TABLE evidences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_stop_id UUID REFERENCES route_stops(id),
    work_order_id UUID REFERENCES work_orders(id),
    type VARCHAR(50) NOT NULL, -- FOTO_ENTREGA, GUIA_FIRMADA, ACTA, OTRO
    file_url TEXT NOT NULL,
    uploaded_by UUID REFERENCES profiles(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 13. EXPENSES (Gastos)
CREATE TABLE expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_id UUID REFERENCES routes(id),
    work_order_id UUID REFERENCES work_orders(id), -- Optional: If directly associated to OT
    type VARCHAR(50) NOT NULL, -- COMBUSTIBLE, PEAJE, ESTIBA, ETC.
    provider_name VARCHAR(150),
    document_number VARCHAR(50),
    amount NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'PEN',
    evidence_url TEXT,
    reported_by UUID REFERENCES profiles(id),
    date DATE NOT NULL,
    observations TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add Row Level Security (RLS) basics (Policies to be refined later)
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE carriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidences ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
